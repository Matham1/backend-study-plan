# Study Notes — Testing: Unit, Integration and CI

Oct 23, 2026 · @Mathew Matholomew

After reading this you will know which tests belong at which level of the event-booking API, and how pytest, fakes, FastAPI's test tools and real containers fit together. You will be able to write fast unit tests for booking rules, integration tests against real Postgres, Redis and Kafka with per-test rollback, a concurrency test that proves no overselling, a Hypothesis property, and a GitHub Actions pipeline that runs it all. Each section explains the mechanism first, then shows capstone-shaped code, then lists the traps.

## 1. What to test, and at which level

Put each check at the lowest level that can catch the bug. Lower tests are fast and pinpoint failures; higher tests are slow but prove that the parts really work together. Ham Vocke's "Practical Test Pyramid" (on Martin Fowler's site) sums up the rule: "Push your tests as far down the test pyramid as you can."

### The levels, defined for this capstone

- **Unit tests** exercise one piece of behaviour with no I/O. In a layered app the useful "unit" is usually a *service-layer use case* (`book_seat`, `cancel_booking`) running against an in-memory fake repository. This is what Vocke calls a *sociable* test: real domain objects collaborate, only the I/O edge is replaced. A test that mocks every collaborator is *solitary*; it pins implementation and breaks on refactors.
- **Integration tests** check your code against one real external thing: the SQLAlchemy repository against real Postgres, the cache against real Redis, the producer against real Kafka. They catch SQL mistakes, wrong isolation levels, serialization bugs and migration drift that no fake can see.
- **API tests** call FastAPI in-process through its ASGI interface. They check routing, validation, status codes, error bodies and dependency wiring. With fakes behind them they are nearly as fast as unit tests; with a real database they become integration tests.
- **End-to-end tests** drive the whole system as a user would: HTTP request in, row in Postgres, `booking.created` on Kafka, worker side effect out. Keep a handful, one per critical journey.

### Speed versus confidence

| Level | Typical speed | What it proves | What breaks it falsely |
| --- | --- | --- | --- |
| Unit (service + fakes) | \~1 ms | Business rules: sold out, duplicate, past event | Almost nothing if you test behaviour |
| API (TestClient + fakes) | \~5–20 ms | HTTP contract: codes, schemas, Problem Details | Schema renames |
| Integration (containers) | 10–200 ms per test, seconds of startup | SQL, locking, TTLs, Kafka serialization | Container startup, port issues |
| End-to-end | seconds | The journey works when deployed | Timing, ordering, environment |

A healthy suite for this project might have 100+ unit tests, 30–50 API tests, 20–40 integration tests and 2–5 end-to-end tests. If the end-to-end layer grows biggest, you have an "ice-cream cone": slow, flaky and hard to debug.

&#91;embedded content: test pyramid for the booking API · 4 levels\]

The wide base is where most checks live; each level up adds fewer, slower tests that prove the wiring the level below cannot see.

### Why the service layer is the sweet spot

The booking rules live in a function like this. It depends on an abstract repository and a unit of work, not on SQLAlchemy:

```python
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol


class SoldOut(Exception): ...
class AlreadyBooked(Exception): ...
class EventInPast(Exception): ...


@dataclass
class Event:
    id: int
    capacity: int
    starts_at: datetime
    booked: int = 0


class EventRepository(Protocol):
    def get(self, event_id: int) -> Event | None: ...
    def has_booking(self, event_id: int, user_id: int) -> bool: ...
    def add_booking(self, event_id: int, user_id: int) -> int: ...


def book_seat(repo: EventRepository, event_id: int, user_id: int, now: datetime) -> int:
    event = repo.get(event_id)
    if event is None:
        raise LookupError(event_id)
    if event.starts_at <= now:
        raise EventInPast(event_id)
    if repo.has_booking(event_id, user_id):
        raise AlreadyBooked(event_id)
    if event.booked >= event.capacity:
        raise SoldOut(event_id)
    event.booked += 1
    return repo.add_booking(event_id, user_id)
```

Every branch here can be covered in milliseconds with a fake repository. Only one question remains for the integration layer: does the *real* repository enforce `booked <= capacity` under concurrency? That is a database question, so it gets a database test (section 7).

### Pitfalls

- Testing the same rule at every level. Cover "sold out" exhaustively in unit tests; one API test checks it maps to 409.
- Calling something a unit test when it opens a socket. If it needs Docker, mark it `integration`.
- Testing private helpers directly. Test through the use case; helpers are implementation detail.
- Skipping integration tests because unit tests are green. Fakes cannot prove your `SELECT ... FOR UPDATE` works.

## 2. pytest fundamentals

pytest is a plugin-driven test runner. It collects test functions, works out which fixtures each one needs, builds them in dependency order, runs the test and tears the fixtures down. Almost every advanced technique in this doc is just a fixture with the right scope.

### Discovery and assert rewriting

By default pytest walks `testpaths` (or the current directory) and collects files named `test_*.py` or `*_test.py`. Inside them it collects `test_*` functions and `test_*` methods on `Test*` classes that have no `__init__`. You can change these patterns with `python_files`, `python_functions` and `python_classes`.

You write a plain `assert`. At import time pytest rewrites the bytecode of test modules (and `conftest.py`) so a failing assert prints the values of each sub-expression. That is why you never need `assertEqual`. Rewriting applies only to modules pytest imports as tests or plugins. If a helper module in your test package does assertions, register it with `pytest.register_assert_rewrite("tests.helpers")` before it is imported.

### Fixtures: dependency injection by argument name

A test names a fixture as a parameter; pytest finds the fixture, runs it and passes the result. Fixtures can request other fixtures, forming a graph. Within one test, each fixture runs once and is cached, so two fixtures that both ask for `repo` share the same object.

**Scopes** control how long a fixture lives: `function` (default), `class`, `module`, `package`, `session`. A wider-scoped fixture must not depend on a narrower one; pytest raises `ScopeMismatch` if it does. This is the key to integration testing: a `session` fixture starts Postgres once, while a `function` fixture gives each test a clean transaction.

**Yield fixtures** split setup and teardown around `yield`. Teardown runs after the test, even when the test fails, in reverse order of setup. If the fixture itself raises *before* `yield`, its teardown never runs, so keep one state change per fixture.

**Factories as fixtures** return a function instead of an object. Use them when a test needs several objects with different attributes.

```python
# tests/conftest.py
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta

import pytest

from app.domain import Event
from tests.fakes import FakeEventRepository

NOW = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)


@pytest.fixture
def now() -> datetime:
    return NOW


@pytest.fixture
def make_event() -> Callable[..., Event]:
    counter = 0

    def _make(capacity: int = 10, starts_in: timedelta = timedelta(days=7), booked: int = 0) -> Event:
        nonlocal counter
        counter += 1
        return Event(id=counter, capacity=capacity, starts_at=NOW + starts_in, booked=booked)

    return _make


@pytest.fixture
def repo() -> Iterator[FakeEventRepository]:
    fake = FakeEventRepository()
    yield fake          # the test runs here
    fake._events.clear()  # teardown: runs even if the test failed
```

### conftest.py layering

A `conftest.py` makes its fixtures available to every test in its directory and below, with no import. Put general fixtures at `tests/conftest.py`, container fixtures in `tests/integration/conftest.py`, and API client fixtures in `tests/api/conftest.py`. A deeper conftest can override a fixture with the same name, and the override can request the original by that name to extend it. Never `import` fixtures from another test module; use `pytest_plugins = ["tests.fixtures.db"]` in the root conftest if you need to share a fixture module.

```text
tests/
  conftest.py              # now, make_event, fake repo, markers
  unit/test_booking.py
  api/conftest.py          # client with dependency_overrides -> fakes
  api/test_bookings_api.py
  integration/conftest.py  # containers, engine, db_session with rollback
  integration/test_repository.py
  e2e/test_booking_flow.py
```

### parametrize: one test, many cases

`@pytest.mark.parametrize` generates one test per row. Give each row a readable id with `pytest.param(..., id="sold-out")`; the id appears in the test name, so `-k sold-out` selects it. With `indirect=True`, each value goes to a fixture of the same name through `request.param`, so the fixture can build something from it.

```python
from datetime import timedelta

import pytest

from app.domain import EventInPast, SoldOut, book_seat
from tests.fakes import FakeEventRepository


@pytest.mark.parametrize(
    ("capacity", "booked", "starts_in", "expected"),
    [
        pytest.param(10, 10, timedelta(days=1), SoldOut, id="sold-out"),
        pytest.param(10, 0, timedelta(days=-1), EventInPast, id="past-event"),
        pytest.param(10, 0, timedelta(0), EventInPast, id="starts-now"),
    ],
)
def test_booking_rejected(make_event, now, capacity, booked, starts_in, expected) -> None:
    event = make_event(capacity=capacity, booked=booked, starts_in=starts_in)
    repo = FakeEventRepository([event])
    with pytest.raises(expected):
        book_seat(repo, event.id, user_id=1, now=now)


@pytest.fixture
def event_with(request, make_event):
    return make_event(capacity=request.param)   # value arrives via request.param


@pytest.mark.parametrize("event_with", [1, 5], indirect=True, ids=lambda c: f"cap={c}")
def test_fill_to_capacity(event_with, now) -> None:
    repo = FakeEventRepository([event_with])
    for user_id in range(event_with.capacity):
        book_seat(repo, event_with.id, user_id, now)
    with pytest.raises(SoldOut):
        book_seat(repo, event_with.id, 999, now)
```

Collected names come out as `test_booking_rejected[sold-out]` and `test_fill_to_capacity[cap=5]`. I ran this suite locally with pytest 9.1 to check the ids.

### Markers and selection

Markers are labels. Register them so typos fail loudly with `--strict-markers`:

```toml
# pyproject.toml
[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-ra --strict-markers"
markers = [
    "integration: needs Docker containers",
    "e2e: full stack through Kafka",
    "slow: takes more than a second",
]
```

Then `pytest -m "not integration"` runs the fast suite, and `pytest -m integration` runs the rest. You can mark a whole directory by adding `pytestmark = pytest.mark.integration` in each module, or by a `pytest_collection_modifyitems` hook in `tests/integration/conftest.py` that adds the marker to every item under that path.

### CLI flags worth memorizing

| Flag | Use |
| --- | --- |
| `-x` / `--maxfail=3` | Stop at the first or third failure |
| `-k "sold and not past"` | Select by name expression |
| `-m "not integration"` | Select by marker expression |
| `--lf` / `--ff` | Rerun last failures only / run them first |
| `-vv`, `-q`, `-ra` | More detail, less detail, summary of skips and failures |
| `-s` | Do not capture stdout (see prints) |
| `--pdb` | Drop into the debugger on failure |
| `--durations=10` | Show the 10 slowest tests and fixtures |
| `--collect-only -q` | List tests without running them |
| `-p no:randomly` | Disable a plugin for one run |

### Pitfalls

- A `session` fixture that requests a `function` fixture raises `ScopeMismatch`. Design scopes outer to inner.
- Mutable objects returned from wide-scoped fixtures leak state between tests. Return fresh objects or reset in teardown.
- `autouse=True` fixtures are invisible in test signatures. Use them only for global hygiene (clock, env vars).
- Unregistered markers only warn unless you set `--strict-markers`. Set it.
- Parametrizing with objects gives ids like `event0`. Always pass `id=` or `ids=`.

## 3. Test doubles: fakes, stubs, mocks, spies

A test double stands in for a real collaborator. The kinds differ in *what the test checks*. Stubs and fakes support **state verification**: run the code, then inspect the result. Mocks and spies support **behaviour verification**: assert which calls were made. For domain logic, state verification wins because it survives refactoring.

| Double | What it is | How the test checks | Good for | Cost |
| --- | --- | --- | --- | --- |
| Dummy | Placeholder that is never used | Not at all | Filling a required argument | None |
| Stub | Returns canned answers | Outcome of the code under test | "Payment gateway says declined" | Low; can drift from reality |
| Fake | Working, simplified implementation (dict-backed repo) | Outcome, by reading the fake's state | Repositories, unit of work, message bus | You maintain it; needs its own contract tests |
| Mock | Object that records calls and is asserted on | `assert_called_once_with(...)` | Side effects at the edge: email sent, event published | Couples tests to call shape |
| Spy | Wraps the real object and records calls | Real behaviour plus call assertions | Checking a real function was called | Still couples to call shape |

### Why fakes beat mocks for domain logic

*Architecture Patterns with Python* (Percival and Gregory) makes this case in chapters 3 and 5. A mock-heavy test describes *how* the code talks to its collaborators. Rename a method, split a query in two, or batch two calls, and the test fails although behaviour is unchanged. A fake describes *what* is true afterwards: "one booking exists, the event shows 1 seat taken". Chapter 5 adds that once you have a service layer and a fake repository, most tests can move up from the domain model to the use-case level and still run in memory, which is the "high gear" of the test suite.

The fake must behave like the real thing in the ways your code relies on. Keep it tiny:

```python
# tests/fakes.py
import itertools

from app.domain import Event


class FakeEventRepository:
    def __init__(self, events: list[Event] | None = None) -> None:
        self._events: dict[int, Event] = {e.id: e for e in events or []}
        self._bookings: dict[int, tuple[int, int]] = {}
        self._ids = itertools.count(1)   # never reuse ids, like a DB sequence

    def get(self, event_id: int) -> Event | None:
        return self._events.get(event_id)

    def has_booking(self, event_id: int, user_id: int) -> bool:
        return (event_id, user_id) in self._bookings.values()

    def add_booking(self, event_id: int, user_id: int) -> int:
        booking_id = next(self._ids)
        self._bookings[booking_id] = (event_id, user_id)
        return booking_id

    def cancel(self, booking_id: int) -> None:
        event_id, _ = self._bookings.pop(booking_id)
        self._events[event_id].booked -= 1


class FakeUnitOfWork:
    def __init__(self, repo: FakeEventRepository) -> None:
        self.events = repo
        self.committed = False
        self.published: list[dict] = []     # outbox / Kafka messages to send

    async def __aenter__(self) -> "FakeUnitOfWork":
        return self

    async def __aexit__(self, *exc: object) -> None:
        pass

    async def commit(self) -> None:
        self.committed = True
```

A test then reads like a specification: `assert uow.committed` and `assert uow.published == [{"type": "booking.created", ...}]`. No call-order assertions at all.

To keep the fake honest, run the *same* repository test functions against both the fake and the SQLAlchemy repository. A parametrized fixture `repo` with params `["fake", "sql"]` does this; the `sql` variant is marked `integration`.

### unittest.mock and pytest-mock

Use mocks at the true edges: SMTP, an HTTP call to a payment provider, the Kafka producer when you only test the service layer. `pytest-mock` provides a `mocker` fixture that wraps `unittest.mock.patch` and undoes every patch automatically at teardown.

**Patch where the name is looked up, not where it is defined.** `from app.notify import send_email` copies a reference into `app.service`'s namespace. Patching `app.notify.send_email` afterwards changes the original module but not the copy, so the real function still runs.

```python
# app/service.py
from app.notify import send_email

def confirm(user_email: str, event_name: str) -> None:
    send_email(user_email, f"Booked: {event_name}")


# tests/unit/test_confirm.py
from app import service


def test_confirm_sends_email(mocker) -> None:
    # Wrong: mocker.patch("app.notify.send_email") leaves service's copy intact.
    send = mocker.patch("app.service.send_email", autospec=True)
    service.confirm("a@b.kz", "Jazz night")
    send.assert_called_once_with("a@b.kz", "Booked: Jazz night")
```

**Autospec.** A bare `Mock` accepts any call and any attribute. `autospec=True` (or `create_autospec(func)`) copies the real signature, so calling the mock with the wrong arguments raises `TypeError`, and misspelled methods raise `AttributeError`. Without it, your test keeps passing after the real function's signature changes.

**Spies.** `mocker.spy(module, "name")` wraps the real function: it still runs, and you can assert on the calls.

### Assertion pitfalls I verified on Python 3.13

- `assert_called_with` checks only the **last** call. Use `assert_called_once_with` or `assert_has_calls([...])` when there are several.
- Misspelled assertion methods: since Python 3.12, `Mock` raises `AttributeError` for names like `called_once_with` or `assret_called`. But an invented name such as `has_been_called_with` is still created silently and returns a truthy `Mock`, so `assert m.has_been_called_with(1)` always passes. Autospec closes that hole.
- `assert m.called` passes if *any* call happened. It says nothing about arguments.
- Patching an `async def` function: `patch` auto-creates an `AsyncMock` when the target is a coroutine function. Assert with `assert_awaited_once_with`, which also fails if the coroutine was created but never awaited.

### Over-mocking smells

- The test has more `patch` lines than assertions.
- You mock types you own (your repository, your domain objects) instead of using a fake.
- The test asserts the exact sequence of internal calls.
- A pure refactor turns several tests red.
- You mock SQLAlchemy `Session.execute`. That tests that you call SQLAlchemy, not that your SQL works. Use a real database instead.

### Pitfalls

- Fakes that are smarter than the real system (for example, enforcing capacity atomically when Postgres code does not). Run shared contract tests.
- `patch` used as a decorator injects arguments bottom-up. With `mocker` you avoid that ordering puzzle.
- Forgetting `autospec` on the edges you do mock.
- Mocking the clock with `patch("datetime.datetime")` fails on C types. Pass `now` as a parameter or use time-machine (section 9).

## 4. Testing FastAPI

FastAPI is an ASGI app: a single async callable that receives a request scope and sends response messages. Test clients exploit that. They call the app directly in-process, with no server and no sockets, so an API test costs a few milliseconds.

### TestClient versus AsyncClient + ASGITransport

|  | `fastapi.testclient.TestClient` | `httpx.AsyncClient(transport=httpx.ASGITransport(app=app))` |
| --- | --- | --- |
| Test style | Plain `def` tests | `async def` tests |
| How it runs the app | Starts its own event loop in a background thread (via AnyIO portal) | Runs the app in *your* test's event loop |
| Lifespan (startup/shutdown) | Runs when used as `with TestClient(app) as c:` | Not run; wrap with `asgi_lifespan.LifespanManager` if needed |
| Sharing async objects with the app | Awkward: different loop and thread | Natural: same loop, so an async SQLAlchemy session from a fixture works |
| Best for | Week 2 API tests with fakes | Week 3+ tests that share an async DB session or call other async code |

The rule of thumb: if your fixtures are async (an `AsyncSession`, a Redis client), use `AsyncClient` so everything lives on one loop. Mixing `TestClient` with async fixtures gives the classic error "attached to a different loop".

### dependency\_overrides: swap the wiring, not the code

`app.dependency_overrides` is a dict. The key is the *original* dependency callable you passed to `Depends`; the value is a replacement callable. FastAPI resolves the replacement's own parameters like any dependency. It is global state on the app object, so clear it in fixture teardown.

```python
# app/api/deps.py
def get_booking_service() -> BookingService:
    ...  # real one builds a UoW on an AsyncSession


# tests/api/conftest.py
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_booking_service
from app.main import app


class StubBookingService:
    def __init__(self, result: int | Exception) -> None:
        self.result = result

    async def book(self, event_id: int, user_id: int) -> int:
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as c:      # `with` runs the lifespan
        yield c
    app.dependency_overrides.clear()  # never leak overrides between tests
```

Override at the level where your test boundary sits. For pure HTTP-contract tests, override the service with a stub. For "API + real use case + fake storage", override only the unit-of-work factory with `FakeUnitOfWork`, so the real service code runs.

### Testing status codes and Problem Details

RFC 9457 Problem Details bodies have `type`, `title`, `status`, `detail` and `instance`, with media type `application/problem+json`. Test the contract fields clients rely on, not the human-readable text.

```python
from app.domain import SoldOut


def test_sold_out_maps_to_409_problem(client: TestClient) -> None:
    app.dependency_overrides[get_booking_service] = lambda: StubBookingService(SoldOut(7))

    r = client.post("/events/7/bookings", json={"user_id": 1})

    assert r.status_code == 409
    assert r.headers["content-type"] == "application/problem+json"
    body = r.json()
    assert body["type"].endswith("/problems/sold-out")
    assert body["status"] == r.status_code      # body and header must agree
    assert body["instance"] == "/events/7/bookings"


@pytest.mark.parametrize("query", ["limit=0", "limit=101", "offset=-1", "limit=abc"])
def test_pagination_rejects_bad_params(client: TestClient, query: str) -> None:
    assert client.get(f"/events?{query}").status_code == 422
```

For pagination, also test the edges that pass validation: `offset` past the end returns an empty list (not 404), `limit=100` works, and the `next` link or cursor disappears on the last page. If you map validation errors to Problem Details too, assert that 422 bodies follow the same shape.

### Async client and lifespan

```python
from collections.abc import AsyncIterator

import httpx
import pytest_asyncio
from asgi_lifespan import LifespanManager


@pytest_asyncio.fixture
async def aclient() -> AsyncIterator[httpx.AsyncClient]:
    async with LifespanManager(app) as manager:          # runs startup/shutdown
        transport = httpx.ASGITransport(app=manager.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            yield c
    app.dependency_overrides.clear()
```

I checked locally that a bare `ASGITransport` does not run the lifespan (`app.state` set in startup was missing) while `with TestClient(app)` does. Decide what your lifespan does in tests. If it connects to Kafka, you probably want to override that dependency rather than run it.

### Pitfalls

- `TestClient(app)` without `with` skips the lifespan, so startup-created clients are missing.
- Overrides keyed by the wrong object. The key must be the exact function object used in `Depends`, not a copy or a lambda.
- Creating a module-level `TestClient` shared by all tests. Overrides and app state then leak.
- Asserting full error message strings. They change; `type` and `status` are the contract.
- `ASGITransport` does not stream responses incrementally; test SSE or long streaming endpoints differently.

## 5. Async tests with pytest-asyncio

pytest itself only calls functions. An `async def` test returns a coroutine that nobody awaits, so pytest needs a plugin to run an event loop. pytest-asyncio (1.4.0 at time of writing) is that plugin for asyncio. Its two jobs are: decide *which* tests and fixtures it owns, and decide *which loop* each one runs in.

### Modes: strict and auto

- **strict** (the default): only tests marked `@pytest.mark.asyncio` run as async, and only fixtures decorated with `@pytest_asyncio.fixture` are handled. This lets pytest-asyncio coexist with other async plugins such as AnyIO's.
- **auto**: every `async def` test gets the marker, and every async fixture is handled, even with plain `@pytest.fixture`. The docs recommend it for asyncio-only projects. Your capstone is asyncio-only, so use auto.

I hit the strict-mode trap while verifying this doc: an `async def` fixture under plain `@pytest.fixture` failed with "requested an async fixture ... with no plugin or hook that handled it". Either switch to auto mode or use `@pytest_asyncio.fixture`.

### Loop scope: the setting that bites with databases

pytest-asyncio can create one loop per collector level: function, class, module, package or session. By default each test runs in its own function-scoped loop. That is maximum isolation, but it breaks a common pattern: a session-scoped async engine or Redis client whose connections were created on loop A cannot be used from a test running on loop B. You get errors like "Future attached to a different loop".

The fix is to put the session fixtures *and* the tests on one session-wide loop. Two config keys control the defaults:

| Option | Applies to | Default | Values |
| --- | --- | --- | --- |
| `asyncio_mode` | Which tests and fixtures are handled | `strict` | `strict`, `auto` |
| `asyncio_default_fixture_loop_scope` | Loop used by async fixtures | Unset: falls back to the fixture's own scope (future versions plan `function`) | `function` ... `session` |
| `asyncio_default_test_loop_scope` | Loop used by async tests | `function` | `function` ... `session` |
| `asyncio_debug` | asyncio debug mode | off | `true` / `false` |

```toml
# pyproject.toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "session"
asyncio_default_test_loop_scope = "session"
```

Per fixture or per test you can be explicit. Note that `scope` (how long the *value* is cached) and `loop_scope` (which *loop* it runs in) are separate arguments:

```python
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def engine(pg_url: str) -> AsyncIterator[AsyncEngine]:
    eng = create_async_engine(pg_url, pool_size=20)
    yield eng
    await eng.dispose()


@pytest.mark.asyncio(loop_scope="session")
async def test_engine_is_usable(engine: AsyncEngine) -> None:
    async with engine.connect() as conn:
        assert (await conn.exec_driver_sql("select 1")).scalar() == 1
```

I verified with pytest-asyncio 1.4.0 that, with both defaults set to `session`, tests and a session fixture see the same running loop; with the test default left at `function`, they see different loops. The old `event_loop` fixture no longer exists in 1.x; requesting it fails with a fixture lookup error. Old blog posts that override `event_loop` in conftest are out of date.

### Async fixtures

Async fixtures follow the same rules as sync ones: `yield` splits setup and teardown, scopes cache the value, and dependencies form a graph. Teardown after `yield` runs inside the loop, so you can `await` cleanup such as `await conn.rollback()`.

```python
@pytest_asyncio.fixture
async def redis_client(redis_url: str) -> AsyncIterator[Redis]:
    client = Redis.from_url(redis_url, decode_responses=True)
    yield client
    await client.flushdb()     # per-test isolation for Redis
    await client.aclose()
```

FastAPI's docs use the AnyIO pytest plugin (`@pytest.mark.anyio`) instead. Both work. Pick one per project; pytest-asyncio has the more flexible loop-scope config, which matters for session containers.

### Pitfalls

- Strict mode with unmarked `async def` tests. Current pytest fails them with "async def functions are not natively supported" (older versions only warned and skipped them). Use auto mode.
- Session-scoped async engine with function-scoped loops: "attached to a different loop".
- Blocking calls (`time.sleep`, sync DB drivers) inside async tests freeze the loop and hide concurrency bugs.
- Background tasks left running at test end. Cancel and await them in fixture teardown.
- Copying `event_loop` fixture overrides from older tutorials. They are removed in 1.x.

## 6. Integration tests with real dependencies

Integration tests are only worth having if they hit the real thing: the same Postgres major version, the same Redis, a real Kafka broker. Testcontainers starts those as throwaway Docker containers from your test code and gives you their connection details. The pattern that keeps them fast is: **start containers once per session, migrate once per session, isolate each test with a transaction that is always rolled back.**

### testcontainers-python: names as of 4.15

Install with extras: `pip install "testcontainers[postgres,redis,kafka]"`. The database drivers are *not* included; add `asyncpg` (or `psycopg`) and `redis` yourself.

One recent change matters. In testcontainers 4.15 (which I installed to check), the old flat import paths still work but emit a `DeprecationWarning` pointing to `testcontainers.community.*`. The docs pages still show the old paths. Use the new ones in new code:

| Service | Import | Key methods |
| --- | --- | --- |
| Postgres | `from testcontainers.community.postgres import PostgresContainer` | `PostgresContainer("postgres:16", driver="asyncpg")`, `.get_connection_url(host=None, driver=...)` |
| Redis | `from testcontainers.community.redis import RedisContainer, AsyncRedisContainer` | `.get_client()`, `await .get_async_client()`, `.get_container_host_ip()`, `.get_exposed_port(6379)` |
| Kafka | `from testcontainers.community.kafka import KafkaContainer` | `KafkaContainer("confluentinc/cp-kafka:7.6.0")`, `.with_kraft()`, `.get_bootstrap_server()` |

If your suite runs with `-W error`, the old paths will fail. Note also that Postgres's `driver` defaults to `psycopg2`; for async SQLAlchemy pass `driver="asyncpg"`, which yields `postgresql+asyncpg://...`. Pin image tags: `postgres:latest` today is not `postgres:latest` next year.

Containers are cleaned up by **Ryuk**, a sidecar container that removes everything labelled with your session when the test process exits, even after a crash. Leave it enabled unless your CI forbids privileged sidecars.

### Session-scoped containers

A container start costs 1–10 seconds (Kafka is the slowest). Starting one per test would make a 40-test suite take minutes. So containers are `session` fixtures, written as plain sync fixtures because `with Container() as c:` is sync:

```python
# tests/integration/conftest.py
from collections.abc import Iterator

import pytest
from testcontainers.community.kafka import KafkaContainer
from testcontainers.community.postgres import PostgresContainer
from testcontainers.community.redis import RedisContainer


@pytest.fixture(scope="session")
def pg_url() -> Iterator[str]:
    with PostgresContainer("postgres:16-alpine", driver="asyncpg") as pg:
        yield pg.get_connection_url()


@pytest.fixture(scope="session")
def redis_url() -> Iterator[str]:
    with RedisContainer("redis:7-alpine") as r:
        yield f"redis://{r.get_container_host_ip()}:{r.get_exposed_port(6379)}/0"


@pytest.fixture(scope="session")
def kafka_bootstrap() -> Iterator[str]:
    with KafkaContainer("confluentinc/cp-kafka:7.6.0").with_kraft() as k:
        yield k.get_bootstrap_server()
```

Yield URLs, not container objects. The rest of the suite then depends only on strings, and you can swap containers for a Docker Compose stack in CI by overriding these three fixtures with environment variables.

### Run migrations once per session

Apply your Alembic migrations, not `Base.metadata.create_all()`. The point is to test the schema you will deploy, including constraints such as `CHECK (booked <= capacity)` and unique indexes that live only in migrations.

```python
from alembic import command
from alembic.config import Config


@pytest.fixture(scope="session")
def migrated_db(pg_url: str) -> str:
    cfg = Config("alembic.ini")
    cfg.set_main_option("sqlalchemy.url", pg_url)
    command.upgrade(cfg, "head")   # sync fixture: env.py may call asyncio.run safely
    return pg_url
```

Keep this fixture synchronous. An async Alembic `env.py` usually calls `asyncio.run()`, which fails if a loop is already running. Sync fixtures run outside the test loop, so it works. A cheap extra test: run `upgrade head`, `downgrade base`, `upgrade head` once to catch broken downgrades.

### Per-test isolation: outer transaction plus savepoints

Truncating tables after each test is slow and order-dependent. Instead, each test runs inside one outer transaction that is rolled back at the end, so nothing it writes survives. The trick is that the code under test calls `session.commit()`, which would normally end that outer transaction.

SQLAlchemy 2.0 solves this with `join_transaction_mode="create_savepoint"`. You open a connection, begin a transaction on it, and bind the session to that connection. The session then turns its own BEGIN/COMMIT/ROLLBACK into SAVEPOINT / RELEASE / ROLLBACK TO SAVEPOINT, leaving the outer transaction untouched. Teardown rolls back the outer transaction, discarding even "committed" data.

```python
from collections.abc import AsyncIterator

import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def engine(migrated_db: str) -> AsyncIterator[AsyncEngine]:
    eng = create_async_engine(migrated_db, pool_size=20, max_overflow=40)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture(loop_scope="session")
async def db_session(engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    async with engine.connect() as conn:
        outer = await conn.begin()
        session = AsyncSession(
            bind=conn,
            join_transaction_mode="create_savepoint",
            expire_on_commit=False,
        )
        try:
            yield session
        finally:
            await session.close()
            await outer.rollback()       # everything the test wrote disappears
```

I ran this exact pattern with SQLAlchemy 2.0 async on SQLite: two tests each committed a row and saw it; after the outer rollback the table was empty. To use it in API tests, override your `get_session` dependency to yield this `db_session`.

The diagram below shows how the scopes nest. Wide fixtures pay their cost once; the innermost layer is the only thing rebuilt per test.

&#91;embedded content: fixture scopes for integration tests · session vs function\]

Containers, migrations and the engine are paid for once; each test only opens a connection, begins a transaction and rolls it back.

### When rollback isolation is not enough

Rollback isolation assumes one connection per test. It breaks when the code under test opens its *own* connections: the concurrency test in section 7 (50 sessions), the Kafka worker, or any end-to-end test. Rows inserted inside the uncommitted outer transaction are invisible to other connections. For those tests use a different fixture that commits real data and cleans up afterwards with `TRUNCATE events, bookings RESTART IDENTITY CASCADE`. Mark them so you remember why they are slower.

For Redis, per-test isolation is `FLUSHDB` in teardown (or a different DB number per worker). For Kafka, use a unique topic name or consumer group per test (`f"booking.created.{uuid4().hex[:8]}"`) because you cannot roll back a log.

### Pitfalls

- Using `create_all` instead of migrations. Tests pass while the real schema lacks your constraint.
- Session-scoped `AsyncEngine` on function-scoped event loops (see section 5).
- A test that spawns its own sessions inside a rollback-isolated test sees no data. Use the committing fixture.
- `expire_on_commit=True` (the default) plus async: accessing attributes after commit triggers lazy loads and `MissingGreenlet`. Set it to `False` in tests and in the app.
- Unpinned images and the deprecated import paths. Both work today and break later.
- Running integration tests in parallel with `pytest-xdist`: each worker gets its own session, hence its own containers. That is fine but multiplies startup time and memory.

## 7. Testing concurrency: proving no overselling

Overselling is a race: two transactions both read `booked = 9`, both decide a seat is free, both write `booked = 10`, and you now have 11 bookings for 10 seats. A single-request test can never catch this. You need many transactions overlapping in time, against the real database, then a check on the final state.

### Why this has to be an integration test

The protection lives in Postgres, not in Python. Two common correct designs:

- **Conditional update**: `UPDATE events SET booked = booked + 1 WHERE id = :id AND booked < capacity RETURNING booked`. Zero rows returned means sold out. Under READ COMMITTED, a second writer waits for the first's row lock, then re-checks the `WHERE` against the new row version, so it cannot overshoot.
- **Pessimistic lock**: `SELECT ... FROM events WHERE id = :id FOR UPDATE`, then check and insert. Other transactions block on the lock until the first commits.

Plus a `CHECK (booked <= capacity)` constraint as a backstop. A fake repository cannot show any of this. That is why section 1 left exactly this question to the database layer.

### Making the race real in a test

Three things decide whether your test can actually fail:

1. **One session per task.** Each concurrent booking needs its own `AsyncSession` and connection. Sharing one session serializes everything and also corrupts session state.
2. **Enough connections.** If the pool has 5 connections, only 5 transactions overlap; the other 45 queue. Set `pool_size` to at least N for this test.
3. **A start barrier.** Create all tasks first, make each wait on an `asyncio.Event`, then release them together. Without the barrier, the first tasks may finish before the last ones start.

```python
import asyncio

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.domain import SoldOut
from app.service import book_seat_db


@pytest.mark.integration
async def test_fifty_concurrent_bookings_for_ten_seats(
    engine: AsyncEngine, committed_event_factory
) -> None:
    event_id = await committed_event_factory(capacity=10)   # real COMMIT, not rollback-isolated
    make_session = async_sessionmaker(engine, expire_on_commit=False)
    start = asyncio.Event()

    async def attempt(user_id: int) -> bool:
        await start.wait()
        async with make_session() as session:
            try:
                await book_seat_db(session, event_id, user_id)
                await session.commit()
                return True
            except SoldOut:
                await session.rollback()
                return False

    tasks = [asyncio.create_task(attempt(u)) for u in range(50)]
    await asyncio.sleep(0)          # let every task reach start.wait()
    start.set()
    results = await asyncio.gather(*tasks, return_exceptions=True)

    errors = [r for r in results if isinstance(r, BaseException)]
    assert not errors, errors       # deadlocks or pool timeouts are failures, not "sold out"
    assert sum(r is True for r in results) == 10
    assert await count_bookings(engine, event_id) == 10
```

Note what the asserts check. Counting successes alone is not enough: also read the table through a fresh connection, and make sure no task failed with an unexpected exception. `return_exceptions=True` keeps one crash from hiding the other 49 results.

### Prove the test can fail

A concurrency test that has never been red proves little. Before trusting it, point it at a deliberately broken implementation: read `booked`, then write `booked + 1` with no lock. I simulated both designs in pure asyncio, with an `await asyncio.sleep(0)` standing in for the network round-trip between read and write. The racy version "succeeded" 50 times and left the counter at 1; the atomic version allowed exactly 10. On Postgres, add `SELECT pg_sleep(0.01)` between the read and the write in the broken version to widen the window.

### Deterministic enough

Concurrency tests are probabilistic by nature. You can make them reliable in the *correct* direction:

- A correct implementation must pass every run. The final-state assertions are exact, so there is no flakiness if locking is right.
- A broken implementation should fail almost every run. The barrier, a large pool and N well above capacity (50 vs 10) make the overlap near certain.
- Set timeouts: `asyncio.wait_for(asyncio.gather(...), timeout=10)` turns a deadlock into a clear failure instead of a hung CI job.
- Run it with `--count=20` (pytest-repeat) locally once when you change the booking SQL.

For the API-level variant, fire 50 `aclient.post(...)` calls with `asyncio.gather` through `httpx.AsyncClient` and `ASGITransport`. The app must open a new session per request (no shared test session override) for this to mean anything.

### Pitfalls

- Using the rollback-isolated `db_session` fixture. Other connections cannot see the uncommitted event row, so every booking fails with "not found".
- A pool smaller than N. The test passes because there is no real concurrency.
- Shared `AsyncSession` across tasks. It is not safe for concurrent use.
- Asserting only on HTTP 201 counts. Also check the database.
- Retrying on serialization failures inside the test instead of inside the app. If the app needs retries under `REPEATABLE READ`, they belong in the service layer.

## 8. Property-based testing with Hypothesis

An example-based test checks the cases you thought of. A property-based test states a rule that must hold for *every* input, and Hypothesis searches for an input that breaks it. When it finds one, it shrinks it to the simplest failing case and saves it in a local database (`.hypothesis/`), so the next run replays it first.

### Strategies

A strategy describes how to generate values. You compose small ones into the shapes your code takes:

```python
from hypothesis import strategies as st

capacities = st.integers(min_value=0, max_value=50)
user_ids = st.lists(st.integers(min_value=1, max_value=30), max_size=100)  # repeats on purpose
emails = st.emails()
event_names = st.text(min_size=1, max_size=200)
events = st.builds(EventCreate, name=event_names, capacity=capacities)   # Pydantic models too
when = st.datetimes(timezones=st.just(UTC))
```

Useful tools: `st.builds` calls a constructor with generated arguments, `st.sampled_from([...])` picks from a list, `st.one_of` mixes strategies, `.map()` transforms, and `.filter()` drops values (use sparingly; prefer bounds). Keep the domain small enough that collisions happen. With `user_ids` drawn from 1..30, duplicates are common, which is exactly what exercises `AlreadyBooked`.

### Shrinking

Hypothesis does not report the random monster it first found. It repeatedly simplifies the input (smaller numbers, shorter lists, earlier list items) while the test still fails. I planted a bug that only triggers when `booked >= 100`. Hypothesis reported `capacity=101, booked=100`, the smallest pair that reaches it. Current versions print this as "Failing test case". Shrinking is why a failing property test is usually easy to debug.

### A property for the capstone

"Total booked never exceeds capacity" is the core invariant. Make it stronger by also stating what the exact result must be:

```python
from datetime import UTC, datetime, timedelta

from hypothesis import given, strategies as st

NOW = datetime(2026, 11, 1, tzinfo=UTC)


@given(
    capacity=st.integers(min_value=0, max_value=50),
    user_ids=st.lists(st.integers(min_value=1, max_value=30), max_size=100),
)
def test_bookings_never_exceed_capacity(capacity: int, user_ids: list[int]) -> None:
    event = Event(id=1, capacity=capacity, starts_at=NOW + timedelta(days=1))
    repo = FakeEventRepository([event])
    succeeded = 0
    for uid in user_ids:
        try:
            book_seat(repo, 1, uid, NOW)
            succeeded += 1
        except (SoldOut, AlreadyBooked):
            pass
    assert event.booked == succeeded <= capacity
    assert succeeded == min(capacity, len(set(user_ids)))   # exact, not just a bound
```

The second assert is the important one. A bound alone would pass for an implementation that rejects every booking.

### Stateful testing: sequences of book and cancel

Single calls rarely break a booking system. Sequences do: book, cancel, rebook, cancel someone else's. `RuleBasedStateMachine` lets you declare *actions* (rules) and *invariants*; Hypothesis generates whole programs of actions, runs them, checks invariants after each step, and shrinks failing programs to the shortest one.

Key pieces: `@initialize` runs once first; `@rule` is an action; `Bundle` is a pool of values produced by earlier rules (booking ids); `consumes(bundle)` draws a value and removes it, so you never cancel twice; `multiple()` returns zero values to a bundle; `@invariant` runs after every step; `@precondition` enables a rule only in some states.

```python
from hypothesis import settings, strategies as st
from hypothesis.stateful import (
    Bundle, RuleBasedStateMachine, consumes, initialize, invariant, multiple, rule,
)


class BookingMachine(RuleBasedStateMachine):
    bookings = Bundle("bookings")

    @initialize(capacity=st.integers(min_value=1, max_value=5))
    def create_event(self, capacity: int) -> None:
        self.event = Event(id=1, capacity=capacity, starts_at=NOW + timedelta(days=1))
        self.repo = FakeEventRepository([self.event])
        self.holders: set[int] = set()          # the simple model we compare against

    @rule(target=bookings, user_id=st.integers(min_value=1, max_value=10))
    def book(self, user_id: int):
        try:
            booking_id = book_seat(self.repo, 1, user_id, NOW)
        except SoldOut:
            assert len(self.holders) == self.event.capacity
            return multiple()                     # nothing added to the bundle
        except AlreadyBooked:
            assert user_id in self.holders
            return multiple()
        assert user_id not in self.holders
        self.holders.add(user_id)
        return booking_id

    @rule(booking_id=consumes(bookings))
    def cancel(self, booking_id: int) -> None:
        _, user_id = self.repo._bookings[booking_id]
        self.repo.cancel(booking_id)
        self.holders.discard(user_id)

    @invariant()
    def matches_model(self) -> None:
        assert 0 <= self.event.booked <= self.event.capacity
        assert self.event.booked == len(self.holders)


BookingMachine.TestCase.settings = settings(max_examples=200, stateful_step_count=30)
TestBookingMachine = BookingMachine.TestCase       # pytest collects this
```

This test caught a real bug while I was writing this doc. My first fake generated ids with `len(self._bookings) + 1`. After a cancel, the next booking reused a live id and overwrote another user's booking. Hypothesis shrank it to a 10-step program: book, cancel, book again, then book a second user. The fix was an `itertools.count()` id sequence, like a database sequence. That is the kind of bug example tests almost never find.

### Settings and profiles

Use profiles so CI can search harder than your laptop:

```python
# tests/conftest.py
import os

from hypothesis import settings

settings.register_profile("dev", max_examples=50)
settings.register_profile("ci", max_examples=500, deadline=None)
settings.load_profile(os.getenv("HYPOTHESIS_PROFILE", "dev"))
```

`deadline=None` turns off the per-example time limit (200 ms by default), which otherwise flags slow examples on busy CI runners.

### Pitfalls

- Properties that restate the implementation (`assert f(x) == same_formula(x)`). State a relationship the code must satisfy instead.
- Over-filtering with `.filter()` or `assume()`. Hypothesis gives up with a health-check error. Use bounds or `st.builds`.
- Hypothesis against a real database: each example must start clean, and function-scoped fixtures are *not* reset between examples of one test (Hypothesis warns about this). Reset state inside the test body, or keep properties on fakes.
- Committing `.hypothesis/` to git. Ignore it; cache it in CI if you want replay.
- Forgetting that the fake must mirror the real repository's rules. The property is only as good as the fake; back it with shared contract tests.

## 9. Test data and quality: factory\_boy, coverage, time control

Three tools keep a growing suite readable and honest. Factories remove repetitive setup. Coverage shows what was never executed. Time control makes date rules testable without sleeping.

### factory\_boy with SQLAlchemy

A factory declares sensible defaults for a model, so a test states only the fields that matter to it: `EventFactory(capacity=1)` says "this test is about capacity". Every other field gets a valid value. That makes tests shorter, and it makes them robust when you add a new required column (you change one factory, not 40 tests).

`SQLAlchemyModelFactory` adds the object to a session. Its `Meta` options:

| Option | Meaning |
| --- | --- |
| `sqlalchemy_session` | The session to add objects to |
| `sqlalchemy_session_factory` | A callable returning a session (since 3.3); use one or the other |
| `sqlalchemy_session_persistence` | `None` (just add), `"flush"` (get ids, stay in the transaction), `"commit"` |
| `sqlalchemy_get_or_create` | Fields used to reuse an existing row instead of inserting |

Use `"flush"` with the rollback-isolated session: rows get primary keys and are visible to queries in the same transaction, and teardown still erases them.

```python
from datetime import UTC, datetime, timedelta

import factory

from app.db.models import BookingRow, EventRow


class EventFactory(factory.alchemy.SQLAlchemyModelFactory):
    class Meta:
        model = EventRow
        sqlalchemy_session_persistence = "flush"

    name = factory.Sequence(lambda n: f"Event {n}")
    capacity = 10
    booked = 0
    starts_at = factory.LazyFunction(lambda: datetime.now(UTC) + timedelta(days=7))

    class Params:
        sold_out = factory.Trait(booked=factory.SelfAttribute("capacity"))
        past = factory.Trait(
            starts_at=factory.LazyFunction(lambda: datetime.now(UTC) - timedelta(days=1))
        )


class BookingFactory(factory.alchemy.SQLAlchemyModelFactory):
    class Meta:
        model = BookingRow
        sqlalchemy_session_persistence = "flush"

    event_id = factory.SelfAttribute("event.id")
    user_id = factory.Sequence(lambda n: n + 1)

    class Params:
        event = factory.SubFactory(EventFactory)


# usage
EventFactory(sold_out=True, capacity=3)   # booked == 3
EventFactory.build()                       # in-memory only, no session
EventFactory.create_batch(25)              # pagination tests
```

I ran these factories against SQLite with a sync session: traits, `SubFactory` and `create_batch` behaved as shown.

**The async catch.** factory\_boy is synchronous; its SQLAlchemy integration calls `session.add()` and `session.flush()` directly, and the docs say nothing about `AsyncSession`. Two workable options: (1) use factories only with `.build()` to construct ORM objects, then `session.add_all(objs)` and `await session.flush()` yourself in a small async helper; or (2) bind the factory to `async_session.sync_session` and call it inside `await session.run_sync(lambda s: EventFactory(...))`. Option 1 is simpler to reason about.

Wire the session per test with an autouse fixture that sets `EventFactory._meta.sqlalchemy_session = ...`, or use `sqlalchemy_session_factory` pointing at a context variable your fixture fills.

### Coverage with pytest-cov

`pytest --cov=app --cov-branch --cov-report=term-missing` measures which lines ran. **Branch coverage** (`--cov-branch`) also records which way each `if` went. Example: `if idempotency_key: cached = await cache.get(idempotency_key)` with no `else`. A single test that sends a key executes every line, so line coverage says 100%. Branch coverage reports the missing "no key" path as a partial branch (`BrPart` in the report). `--cov-fail-under=85` fails the run below a threshold.

```toml
[tool.coverage.run]
source = ["app"]
branch = true

[tool.coverage.report]
show_missing = true
skip_covered = true
exclude_also = ["if TYPE_CHECKING:", "raise NotImplementedError", "\\.\\.\\."]
```

What coverage does **not** tell you:

- Whether you asserted anything. A test that calls the endpoint and checks nothing gives 100% coverage.
- Whether concurrency is safe. The race in section 7 lives between lines, not on them.
- Whether edge values were tried. `capacity = 0`, `limit = 100`, empty strings: a line runs the same way for all of them.
- Whether the SQL is right. Repository lines run against a fake show as covered.

Treat coverage as a map of untested code, not as a quality score. A sensible target for this project is about 85% branch coverage on `app/domain` and `app/service`, and less pressure on wiring code. Collect coverage across both unit and integration jobs and merge the files (`coverage combine`) if you want one number.

### Time control with time-machine

Booking rules depend on "now": no booking for past events, cache TTLs, idempotency keys expiring after 24 hours. Two approaches, best used together:

1. **Inject the clock.** Service functions take `now: datetime` (or a `Clock` protocol). Unit tests pass a fixed value. No library needed.
2. **Travel in time** where you cannot inject: framework code, `datetime.now()` deep inside libraries, JWT expiry. time-machine (3.5 at time of writing) patches the C-level time functions, so it is fast and catches calls from everywhere.

```python
from datetime import UTC, datetime, timedelta

import time_machine


@time_machine.travel(datetime(2026, 11, 1, 12, tzinfo=UTC), tick=False)
def test_event_starting_now_is_closed(client) -> None:
    ...


def test_idempotency_key_expires(time_machine, client) -> None:   # pytest fixture
    time_machine.move_to(datetime(2026, 11, 1, 12, tzinfo=UTC), tick=False)
    first = client.post("/bookings", headers={"Idempotency-Key": "k1"}, json=...)
    time_machine.shift(timedelta(hours=24, seconds=1))
    ...
```

`tick=True` is the default: time keeps flowing from the destination. Use `tick=False` when you need exact equality. Naive datetimes are treated as UTC by default; pass aware datetimes anyway.

One important limit I checked: shifting time-machine did not move `time.monotonic()`, and asyncio's loop clock uses monotonic time. So `asyncio.sleep` and timeouts are unaffected. It also cannot move Redis's server clock. To test Redis TTL expiry, set a short TTL (1 second) and wait, or assert the TTL value with `await redis.ttl(key)` instead of waiting.

### Pitfalls

- Factories with hidden expensive `SubFactory` chains. Building one booking may insert an event, a venue and a user. Know what you create.
- `factory.Faker` producing random data that occasionally hits a constraint (duplicate email). Use `Sequence` for unique fields.
- Chasing 100% coverage. You start testing wiring and lose sight of behaviour.
- Mixing `datetime.now()` (naive, local) and aware datetimes. Use `datetime.now(UTC)` everywhere.
- Expecting time travel to expire keys inside Redis or Postgres. Those servers have their own clocks.

## 10. CI: running the pyramid on every push

CI runs the same pytest commands you run locally, split by marker into a fast job and a slow job. The fast job gives feedback in about a minute on every push. The slow job proves the integration story before merge. Splitting them also tells you at a glance whether a failure is in logic or in infrastructure.

### The split

- **unit job**: `pytest -m "not integration and not e2e"`. No Docker. Domain, service-layer, API-with-fakes and Hypothesis tests. Target under 60 seconds.
- **integration job**: `pytest -m "integration or e2e"`. Needs Docker for testcontainers. GitHub's `ubuntu-latest` (currently Ubuntu 24.04) ships Docker Engine and Docker Compose preinstalled, so testcontainers works with no extra setup. Do not use the `ubuntu-slim` runner: it is unprivileged and cannot run Docker.

Make the integration job depend on the unit job with `needs: unit`. If logic is broken, there is no point paying for container startup.

### A workflow for the capstone

Action versions below are the majors shown in each action's README at the time of writing (checkout, setup-python and upload-artifact are all on v7). I validated the YAML structure locally; check the READMEs again before you copy it.

```yaml
# .github/workflows/tests.yml
name: tests

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: tests-${{ github.ref }}
  cancel-in-progress: true        # a new push cancels the stale run

permissions:
  contents: read

jobs:
  unit:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v7
        with:
          python-version: "3.12"
          cache: pip                              # caches pip's download cache
          cache-dependency-path: requirements*.txt  # cache key = hash of these files
      - run: pip install -r requirements.txt -r requirements-dev.txt
      - name: Unit and API tests
        run: >
          pytest -m "not integration and not e2e"
          --cov=app --cov-branch --cov-report=xml:coverage-unit.xml
          --junitxml=junit-unit.xml
        env:
          HYPOTHESIS_PROFILE: ci
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: unit-reports
          path: |
            coverage-unit.xml
            junit-unit.xml

  integration:
    runs-on: ubuntu-latest
    needs: unit
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v7
        with:
          python-version: "3.12"
          cache: pip
          cache-dependency-path: requirements*.txt
      - run: pip install -r requirements.txt -r requirements-dev.txt
      - name: Pre-pull container images in parallel
        run: |
          docker pull postgres:16-alpine &
          docker pull redis:7-alpine &
          docker pull confluentinc/cp-kafka:7.6.0 &
          wait
      - name: Integration and e2e tests
        run: >
          pytest -m "integration or e2e" -x
          --cov=app --cov-branch --cov-report=xml:coverage-integration.xml
          --durations=15
```

### Caching: what it does and does not save

`setup-python`'s `cache: pip` stores pip's download cache, keyed by a hash of your dependency files. It saves download time but pip still installs packages. It only works well with pinned versions: with loose pins pip may pick newer versions and skip the cache. Lock your dependencies (`pip-compile`, `uv pip compile`, or Poetry/uv lock files). If you use uv, its own setup action has a cache option; check its docs.

Docker images are not cached between runs by default. Pre-pulling the three images in parallel, as above, is a cheap way to shorten the first container start, and keeps pull time out of your test timings. Pinning image tags in both the workflow and the fixtures keeps them consistent.

### Making failures debuggable

- `--junitxml` plus an upload step gives a per-test report even when the job fails (`if: always()`).
- `--durations=15` shows which fixtures are slow. Container startup should appear once, not per test.
- Set `timeout-minutes` on every job. A deadlocked concurrency test should fail in minutes, not hang for six hours (the default job limit).
- On Hypothesis failures, the log prints the shrunk example. Copy it into an `@example(...)` decorator so it becomes a permanent regression test.

### Pitfalls

- Running integration tests in the unit job because a marker is missing. Use `--strict-markers` and a conftest hook that auto-marks everything under `tests/integration/`.
- Unpinned `postgres:latest` making CI fail on a new major release.
- Caching `.venv` directly across Python patch versions; it breaks in confusing ways. Cache pip's download cache instead.
- Requiring the integration job only on `main`. Run it on pull requests so you learn before merge.
- Treating a coverage drop as a failure without reading it. The number is a signal, not the goal.

## Apply it to the capstone

These are guides, not solutions. Each week lists what to build, the shape of the key fixtures, and the checks that matter. Fill in the bodies yourself.

### Week 2: unit tests, API tests, shared fixtures

**Booking rules with parametrize and a fake repository.**

- Start with `tests/fakes.py` (`FakeEventRepository`, `FakeUnitOfWork`) and `tests/conftest.py` (`now`, `make_event`).
- One parametrized test for all rejections: sold out, past event, starts exactly now, event not found. One separate test for duplicates, because it needs a first successful booking.
- Also test the happy path's *effects*: `uow.committed is True`, `event.booked` incremented, one `booking.created` message in `uow.published` with the right payload keys.
- Hint: if `book_seat` calls `datetime.now()` internally, refactor it to accept `now`. That single change makes the "past event" boundary testable.

**API tests: status codes, Problem Details, pagination.**

```python
# tests/api/test_bookings_api.py  (sketch)
CASES = [
    pytest.param(SoldOut(1), 409, "sold-out", id="sold-out"),
    pytest.param(AlreadyBooked(1), 409, "already-booked", id="duplicate"),
    pytest.param(EventInPast(1), 422, "event-in-past", id="past"),
    pytest.param(LookupError(1), 404, "event-not-found", id="missing"),
]

@pytest.mark.parametrize(("error", "status", "slug"), CASES)
def test_domain_errors_map_to_problems(client, error, status, slug) -> None:
    ...  # override service with a stub raising `error`; assert status, media type, type URI
```

- Pagination edges: `limit` at 1 and the maximum, `limit` above the maximum (422), `offset` beyond total (200, empty items), the last page has no `next`. Use `make_event` in a loop or the factory's `create_batch` later.
- Decide your status codes once (is "past event" 409 or 422?) and write it down; the tests become the spec.

**Shared fixtures.** Root `conftest.py` holds clock and factories; `tests/api/conftest.py` holds `client` with overrides and clears them in teardown. Register markers now (`integration`, `e2e`, `slow`) with `--strict-markers`, even before you use them.

### Week 3: Postgres container, rollback isolation, concurrency

- Fixtures to build, outer to inner: `pg_url` (session, container) → `migrated_db` (session, Alembic upgrade) → `engine` (session, async, `loop_scope="session"`) → `db_session` (function, outer transaction + `create_savepoint`).
- Set `asyncio_mode = "auto"` and both loop-scope defaults to `session` in `pyproject.toml` before you write the first async fixture.
- Repository tests: add + get round trip, `has_booking` true/false, unique constraint on `(event_id, user_id)` raises `IntegrityError`, the `CHECK (booked <= capacity)` constraint rejects a direct bad update. These check the *schema*, which only a real database can.
- Contract tests: parametrize a `repo` fixture over `["fake", "sql"]` and run the same assertions on both. The `sql` param gets `marks=pytest.mark.integration`.
- Concurrency test (50 attempts, 10 seats, exactly 10 succeed): it needs a separate committing fixture and `TRUNCATE` cleanup, because the rollback-isolated session is invisible to the 50 other connections. Set `pool_size >= 50`. Then break your SQL on purpose (drop the `WHERE booked < capacity` or the `FOR UPDATE`) and confirm the test turns red.

```python
@pytest_asyncio.fixture(loop_scope="session")
async def committed_event_factory(engine: AsyncEngine) -> AsyncIterator[Callable[..., Awaitable[int]]]:
    async def _create(capacity: int) -> int:
        ...  # INSERT ... RETURNING id in its own committed transaction
    yield _create
    async with engine.begin() as conn:
        await conn.exec_driver_sql("TRUNCATE bookings, events RESTART IDENTITY CASCADE")
```

### Week 4: Redis container, cache, TTL, 429, idempotency

- `redis_url` session fixture; function-scoped async `redis_client` that runs `FLUSHDB` in teardown. Override your app's Redis dependency to use it.
- **Cache tests**: first `GET /events/{id}` misses and stores; second hits (prove it by counting repository calls with a spy, or by changing the DB row and seeing the stale value). After an update, the key is invalidated.
- **TTL**: assert `0 < await redis.ttl(key) <= 60` rather than sleeping 60 seconds. For one real expiry test, configure a 1-second TTL in the test settings and wait slightly longer. time-machine cannot move Redis's clock.
- **429**: send `limit + 1` requests within one window; the last one returns 429 with a `Retry-After` header and a Problem Details body. Then check a different client key is unaffected.
- **Idempotency key**: same key + same body twice → same response, one booking row. Same key + different body → 422 or 409 (your choice, documented). Concurrent duplicates with the same key → still one booking (reuse your `asyncio.gather` barrier).

### Week 6: Kafka container, worker consumes exactly once

- `kafka_bootstrap` session fixture with `KafkaContainer(...).with_kraft()`. Per test, a unique topic name and consumer group id from `uuid4()`, so tests cannot read each other's messages.
- Test the producer: after a booking, consume from the topic with a short timeout and assert one `booking.created` with the expected key (booking id) and schema.
- Test the worker in-process: start its consume loop as an `asyncio.Task`, publish a message, wait for the side effect, then cancel and await the task in teardown.
- "Exactly once" in practice means *effectively once*: Kafka delivers at least once, so the worker must be idempotent (for example, a `processed_messages` table with a unique key). Test it by publishing the **same** event twice and asserting one notification.
- Never `sleep(5)` and hope. Poll with a deadline:

```python
async def eventually(check: Callable[[], Awaitable[bool]], timeout: float = 10.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not await check():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.1)
```

### Week 8: one fixture set, e2e, Hypothesis, factories, coverage, CI

- **One session fixture set**: move `pg_url`, `redis_url`, `kafka_bootstrap` into `tests/integration/conftest.py` (or a `tests/fixtures/containers.py` plugin loaded via `pytest_plugins`). Add an env-var escape hatch: if `TEST_PG_URL` is set, yield it instead of starting a container. That lets you run against a Docker Compose stack.
- **End-to-end test**: `POST /bookings` through `AsyncClient` with the real app wiring → assert 201 → `eventually` the worker recorded a notification → the database shows one booking. Mark it `e2e`. One or two of these are enough.
- **Hypothesis**: the capacity property on fakes in the unit job, plus the `RuleBasedStateMachine` for book/cancel. Optional stretch: run the state machine against the SQL repository with a small `max_examples`, resetting tables in `@initialize`.
- **factory\_boy**: `EventFactory`, `BookingFactory`, `UserFactory` with `Sequence` for unique fields; decide on the async strategy (build-then-add helper) and use it everywhere.
- **Coverage**: `--cov-branch` in both CI jobs; look at the missing branches in `app/service` and add tests for real gaps only.
- **Markers + CI**: auto-mark by directory in a `pytest_collection_modifyitems` hook, then the workflow from section 10. Confirm locally that `pytest -m "not integration and not e2e"` runs without Docker running.

## Check yourself

1. Your teammate wants to test "sold out" with an end-to-end test through Kafka. What do you suggest, and why?
2. What is the difference between a fake and a mock? When would you still choose a mock in this project?
3. `app/service.py` does `from app.notify import send_email`. You patch `app.notify.send_email` and the real email still sends. Why, and what is the fix?
4. What does `autospec=True` protect you from? Give one concrete failure it catches.
5. Explain fixture scopes in a setup with a Postgres container and per-test isolation. What happens if a session fixture requests a function fixture?
6. How does `join_transaction_mode="create_savepoint"` let code under test call `commit()` while the test still rolls everything back?
7. Your async tests fail with "attached to a different loop" after you made the engine session-scoped. What is going on and how do you fix it in pytest-asyncio 1.x?
8. `TestClient` versus `httpx.AsyncClient` with `ASGITransport`: what are the differences regarding the event loop and lifespan?
9. You wrote the "50 concurrent bookings, 10 seats" test and it passes. How do you know it can actually catch a race?
10. Why does the concurrency test not work with the rollback-isolated `db_session` fixture?
11. What does shrinking do in Hypothesis, and why does a stateful test find bugs that example tests miss?
12. Your coverage is 95%. Name three kinds of bugs it says nothing about.

## Answers

1. Push it down. The rule is pure logic, so cover it exhaustively in a service-layer unit test with a fake repository (milliseconds, no flakiness). Add one API test that checks it maps to 409 Problem Details. Keep the end-to-end test for the happy-path journey only.
2. A fake is a working, simplified implementation; you check the resulting state. A mock records calls; you assert on them. Fakes survive refactors; mocks couple tests to call shapes. Use a mock (with autospec) at true edges with no useful state, such as an SMTP sender or a third-party payment client.
3. The import copied a reference into `app.service`'s namespace. Patching the original module does not change that copy. Patch where the name is looked up: `mocker.patch("app.service.send_email", autospec=True)`.
4. It makes the mock enforce the real signature and attributes. If `send_email(to, subject)` gains a required `body` argument and the code is not updated, an autospecced mock raises `TypeError`; a bare `Mock` would accept the stale call and the test would stay green.
5. Session: the container, migrations and engine, built once. Function: a connection with an outer transaction and a session per test. Wider scopes are created first and torn down last. A session fixture requesting a function fixture raises `ScopeMismatch`, because the function value would expire while the session value still holds it.
6. The session is bound to a connection whose transaction the test began. In that mode, the session's own begin/commit/rollback become SAVEPOINT, RELEASE SAVEPOINT and ROLLBACK TO SAVEPOINT. The outer transaction is never committed, so rolling it back in teardown discards everything.
7. The engine's connections were created on the session-level loop, but each test runs on its own function-level loop. Set `asyncio_default_fixture_loop_scope` and `asyncio_default_test_loop_scope` to `session` (or pass `loop_scope="session"` on the fixture and the `asyncio` mark). The old `event_loop` fixture override no longer exists.
8. `TestClient` runs the app on its own loop in a background thread and runs lifespan when used as a context manager; tests are sync. `AsyncClient` with `ASGITransport` runs the app in the test's loop, so it can share async fixtures, but it does not run lifespan; wrap the app with `LifespanManager` if you need it.
9. Make it fail first. Point it at a deliberately racy version (read then write, no lock or conditional update), with a small delay between read and write. It must go red. Also check that the pool size is at least the number of tasks and that a start barrier releases all tasks together.
10. The rows created inside the test's outer transaction are uncommitted, so other connections cannot see them. The 50 concurrent sessions use their own connections, so they would find no event. That test needs committed data and explicit cleanup.
11. Shrinking simplifies a failing input step by step while it still fails, so you get a minimal counterexample. A state machine generates *sequences* of operations (book, cancel, rebook) and checks invariants after each step, which finds order-dependent bugs, like booking-id reuse after a cancel, that single-call tests never try.
12. Missing assertions (code ran but nothing was checked); race conditions (they happen between lines); untried edge values (zero capacity, boundary limits); wrong SQL hidden behind a fake; behaviour of external services.

## Sources

Pages opened while writing these notes. Library versions installed and checked locally: pytest 9.1.1, pytest-asyncio 1.4.0, Hypothesis 6.170, FastAPI 0.161, httpx 0.28, testcontainers 4.15.0, factory\_boy 3.3.3, time-machine 3.5.1, pytest-cov 7.1.

- [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) — Ham Vocke, martinfowler.com
- [Architecture Patterns with Python, ch. 3: On Coupling and Abstractions](https://www.cosmicpython.com/book/chapter_03_abstractions.html)
- [Architecture Patterns with Python, ch. 5: TDD in High Gear and Low Gear](https://www.cosmicpython.com/book/chapter_05_high_gear_low_gear.html)
- [pytest: How to use fixtures](https://docs.pytest.org/en/stable/how-to/fixtures.html)
- [pytest-asyncio: Configuration reference](https://pytest-asyncio.readthedocs.io/en/stable/reference/configuration.html)
- [pytest-asyncio: Concepts](https://pytest-asyncio.readthedocs.io/en/stable/concepts.html)
- [FastAPI: Async Tests](https://fastapi.tiangolo.com/advanced/async-tests/)
- [FastAPI: Testing Dependencies with Overrides](https://fastapi.tiangolo.com/advanced/testing-dependencies/)
- [FastAPI: Testing Events (lifespan)](https://fastapi.tiangolo.com/advanced/testing-events/)
- [testcontainers-python documentation](https://testcontainers-python.readthedocs.io/en/latest/)
- [testcontainers-python: Postgres module](https://testcontainers-python.readthedocs.io/en/latest/modules/postgres/README.html)
- [testcontainers-python: Redis module](https://testcontainers-python.readthedocs.io/en/latest/modules/redis/README.html)
- [testcontainers-python: Kafka module](https://testcontainers-python.readthedocs.io/en/latest/modules/kafka/README.html)
- [SQLAlchemy 2.0: Joining a Session into an External Transaction](https://docs.sqlalchemy.org/en/20/orm/session_transaction.html#joining-a-session-into-an-external-transaction-such-as-for-test-suites)
- [Hypothesis: Stateful testing](https://hypothesis.readthedocs.io/en/latest/stateful.html)
- [factory\_boy: Using factory\_boy with ORMs](https://factoryboy.readthedocs.io/en/stable/orms.html)
- [time-machine: Usage](https://time-machine.readthedocs.io/en/latest/usage.html)
- [GitHub Actions: Workflow syntax](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions)
- [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Ubuntu 24.04 runner image contents](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)
- [actions/setup-python](https://github.com/actions/setup-python)
- [actions/checkout](https://github.com/actions/checkout)
- [actions/upload-artifact](https://github.com/actions/upload-artifact)
