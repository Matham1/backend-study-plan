# Study Notes — Week 0: Project Setup

Oct 23, 2026 · @Mathew Matholomew

By the end of these notes you will have a running skeleton of the event-booking API: Postgres and the API in Docker Compose, an `Event` table created by an Alembic migration, `POST /events` and `GET /events/{id}`, and one passing pytest test. More importantly, you will know why each piece is wired the way it is: why the API waits for a healthy database, why the session lives exactly one request, why autogenerate needs review, and why routers never talk to SQLAlchemy directly. Every later week (concurrency, Redis, Kafka) builds on this skeleton, so the boring parts are worth getting right now.

## 1. Docker Compose for local development

Compose turns one YAML file into a small private network of containers. Each entry under `services:` becomes one or more containers; Compose also creates a default network for the project, and every service is reachable on it by its service name. That is why the API connects to `db:5432`, not `localhost:5432`: inside the API container, `localhost` is the API container itself.

**Image vs build.** `image: postgres:17` pulls a published image. `build: .` builds one from your Dockerfile. Use images for infrastructure (Postgres, Redis, Kafka) and `build` for your own code. You can set both: Compose builds and tags the result with the `image` name.

**Ports.** `"8000:8000"` means host port on the left, container port on the right. Ports only matter for traffic from your laptop (browser, psql, tests run on the host). Container-to-container traffic uses the internal network and needs no published port. Publishing Postgres as `5433:5432` avoids clashing with a local Postgres install.

**Volumes.** A container's filesystem dies with the container. A *named volume* (`pgdata:/var/lib/postgresql/data`) is storage that Docker manages separately, so `docker compose down` keeps your data and `docker compose down -v` deletes it. A *bind mount* (`./app:/code/app`) maps a host folder into the container; use it for source code so `--reload` sees your edits.

**Environment.** Two different mechanisms share the word "env":

| Mechanism | Who reads it | Purpose |
| --- | --- | --- |
| `.env` next to `compose.yaml` | Compose itself | Fills `${VAR}` placeholders in the YAML |
| `env_file: .env` on a service | The container | Injects variables into the process environment |
| `environment:` on a service | The container | Explicit variables; override `env_file` values |

Shell variables beat `.env` during interpolation. A literal `$` in the YAML (for example inside a healthcheck command) must be written `$$` so Compose does not try to interpolate it.

**Healthchecks and startup order.** By default `depends_on` only waits until the database container has *started*. A started Postgres container still needs a few seconds to initialise, so your API (or Alembic) would crash with "connection refused". A healthcheck is a command Docker runs inside the container on an interval; the container is marked `healthy` once it succeeds. `depends_on` with `condition: service_healthy` holds the API back until that happens. The other conditions are `service_started` (the default) and `service_completed_successfully` (useful for a one-shot migration container).

```yaml
# compose.yaml  (the top-level `version:` key is obsolete; omit it)
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-booking}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-booking}
      POSTGRES_DB: ${POSTGRES_DB:-booking}
    ports:
      - "5433:5432"            # host:container, for psql from your laptop
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s

  api:
    build: .
    env_file: .env
    environment:
      DATABASE_URL: postgresql+psycopg://booking:booking@db:5432/booking
    ports:
      - "8000:8000"
    volumes:
      - ./app:/code/app       # bind mount for hot reload
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
```

`$${POSTGRES_USER}` reaches the container as `${POSTGRES_USER}`, which the shell inside the container expands from the container's own environment. `CMD-SHELL` runs the string through `/bin/sh`; the `CMD` form runs the binary directly with no shell, so variables would not expand.

The Postgres image documents its data directory as `/var/lib/postgresql/data` for versions up to 17. Version 18 images changed the recommended mount to `/var/lib/postgresql`, so check the image page when you pick a tag.

```bash
docker compose up -d --build        # build images, start everything in the background
docker compose ps                   # status, including (healthy)
docker compose logs -f api          # follow one service's logs
docker compose exec db psql -U booking booking   # shell into a running container
docker compose run --rm api pytest  # one-off container from the api service
docker compose down                 # stop and remove containers, keep volumes
docker compose down -v              # ...and delete named volumes (fresh DB)
docker compose config               # print the fully interpolated file: debug env issues here
```

**Pitfalls**

- Using `localhost` in `DATABASE_URL` inside a container. Use the service name (`db`).
- Using `depends_on: [db]` without a condition and assuming the DB is ready.
- Changing `POSTGRES_PASSWORD` after the first run. The image only reads it when the data directory is empty; run `down -v` to re-initialise.
- Committing `.env`. Commit a `.env.example` instead.
- Forgetting `--build` after changing `requirements` or the Dockerfile; Compose reuses the old image.
- `uvicorn --host 127.0.0.1` inside a container makes the port unreachable from the host. Bind to `0.0.0.0`.

## 2. FastAPI fundamentals

FastAPI reads your function signature at import time and builds a plan for each route: which parameters come from the path, the query string, the body, or a dependency. At request time it runs that plan, validates every input with Pydantic, calls your function, then validates and serialises the return value. Type hints are not decoration here; they are the routing and validation spec, and the source of the OpenAPI schema at `/docs`.

**Path operations.** A parameter named in the path (`/events/{event_id}`) is a path parameter; a parameter typed as a Pydantic model is the JSON body; other simple types become query parameters. `event_id: int` means a request to `/events/abc` gets a 422 before your code runs.

**Pydantic v2 models: one per direction.** Keep the input model and the output model separate. The input model decides what a client may send; the output model decides what a client may see. `model_config` replaces the v1 inner `class Config`.

```python
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class EventCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=200)
    venue: str | None = None
    starts_at: datetime
    capacity: int = Field(gt=0)


class EventRead(BaseModel):
    # lets Pydantic read attributes off an ORM object, not only dict keys
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    venue: str | None
    starts_at: datetime
    capacity: int
```

`extra="forbid"` turns a typo like `"capcity"` into a 422 instead of a silently ignored field. `from_attributes=True` (v1 called it `orm_mode`) is what lets you return a SQLAlchemy `Event` and have FastAPI convert it.

**`response_model` and status codes.** `response_model=EventRead` filters the return value through `EventRead`: any attribute not declared there (an internal flag, a password hash) is dropped. It also documents the response shape. Set `status_code=201` on create routes; raise `HTTPException(404, ...)` for missing resources. Validation failures are 422 automatically.

```python
from fastapi import APIRouter, HTTPException, status

router = APIRouter(prefix="/events", tags=["events"])


@router.post("", response_model=EventRead, status_code=status.HTTP_201_CREATED)
def create_event(payload: EventCreate, service: EventServiceDep):
    return service.create_event(payload)
```

**Dependency injection with `Depends`.** A dependency is any callable whose parameters FastAPI can resolve, recursively. FastAPI builds a graph, calls each dependency once per request (results are cached within that request), and injects the result. A dependency written as a generator (`yield`) gets setup and teardown: code before `yield` runs before the endpoint, code after it runs once the endpoint is done. That shape is exactly what a database session needs. The `Annotated` alias keeps signatures short and reusable:

```python
from typing import Annotated

from fastapi import Depends
from sqlalchemy.orm import Session

SessionDep = Annotated[Session, Depends(get_session)]


def get_event_service(session: SessionDep) -> EventService:
    return EventService(EventRepository(session))


EventServiceDep = Annotated[EventService, Depends(get_event_service)]
```

The big win is testability: the endpoint asks for "a session", not "the production session". Tests swap the provider without touching the endpoint (section 6).

One subtlety worth knowing now. By default the teardown of a `yield` dependency runs *after the response has been sent*. If your commit lives after `yield` and the commit fails, the client has already received a 201. I confirmed this locally on FastAPI 0.161: the default scope returned 201 despite an exception after `yield`, while `Depends(get_session, scope="function")` returned 500. Recent FastAPI versions accept that `scope` argument; with older ones, commit inside the service instead. Either way, decide deliberately where the commit happens.

**Lifespan.** Process-wide resources (engine pool, later a Redis client and a Kafka producer) are created once at startup and closed at shutdown. FastAPI's `lifespan` is an async context manager: code before `yield` runs before the first request, code after runs on shutdown. The older `@app.on_event("startup")` hooks are deprecated, and if you pass `lifespan` they are not called at all.

```python
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import text


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    with engine.connect() as conn:      # fail fast if the DB is unreachable
        conn.execute(text("SELECT 1"))
    yield
    engine.dispose()                    # close pooled connections


app = FastAPI(title="Event Booking API", lifespan=lifespan)
app.include_router(events_router)
```

**Settings via pydantic-settings.** `BaseSettings` is a Pydantic model whose fields are filled from environment variables (case-insensitive by default), then from a `.env` file, then from defaults. You get type conversion and validation for config, so `SQL_ECHO=yes` becomes `True` and a missing required value fails at startup, not at the first request.

```python
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://booking:booking@localhost:5433/booking"
    sql_echo: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

`lru_cache` makes it a lazy singleton: parsed once, and tests can call `get_settings.cache_clear()` after changing env vars. Real environment variables win over `.env`, which is what you want in Compose: the `environment:` block overrides the file.

**Pitfalls**

- Returning the ORM object without `from_attributes=True` on the response model: serialisation fails.
- One model for input and output. Clients can then set `id`, or you leak fields.
- Doing blocking I/O inside an `async def` endpoint. With sync SQLAlchemy, write `def` endpoints; FastAPI runs them in a threadpool. Mixing `async def` with a blocking session stalls the event loop.
- Swallowing exceptions in a `yield` dependency without re-raising: the client gets a 500 and your logs show nothing.
- Reading `os.environ` all over the code instead of one `Settings` object.

## 3. SQLAlchemy 2.0 ORM

SQLAlchemy has two layers. **Core** builds and runs SQL (`select()`, `insert()`, connections, transactions). The **ORM** maps rows to Python objects and tracks changes to them. Three objects matter:

| Object | Lifetime | Job |
| --- | --- | --- |
| `Engine` | One per process | Holds the connection pool and the dialect (how to talk to Postgres) |
| `sessionmaker` | One per process | Factory that stamps out configured `Session` objects |
| `Session` | One per request (unit of work) | Identity map of loaded objects, pending changes, one transaction at a time |

The `Session` is the part to understand deeply. When you `add()` an object it becomes *pending*; nothing is sent yet. On `flush()` (explicit, or automatic before a query) the session sends the INSERT/UPDATE statements inside the current transaction, so `event.id` gets filled in, but other connections cannot see the row yet. On `commit()` it flushes, then commits the database transaction. A transaction starts automatically the first time the session touches the database ("autobegin"). If anything fails, `rollback()` discards the transaction and the session is usable again. After a failed flush you *must* roll back before reusing the session.

The session also keeps an **identity map**: within one session, primary key 7 of `Event` is always the same Python object. That gives consistency inside a request and is a reason not to share sessions between requests or threads.

**Declarative models, 2.0 style.** You subclass `DeclarativeBase` once; every model inherits from it and registers its table on `Base.metadata` (which Alembic will read). `Mapped[...]` annotations drive both the Python type and the column: `Mapped[str]` is NOT NULL, `Mapped[str | None]` is nullable. `mapped_column()` adds what the annotation cannot express: length, primary key, server default, index. A bare `Mapped[int]` with no assignment gets an implicit `mapped_column()`.

```python
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, String, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (
        CheckConstraint("capacity > 0", name="ck_events_capacity_positive"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    venue: Mapped[str | None] = mapped_column(String(200))
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    capacity: Mapped[int]
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
```

`DateTime(timezone=True)` maps to Postgres `timestamptz`; use it for event times or you will fight time zones later (Astana is UTC+5). The `CHECK` constraint is a database-level guard; it complements Pydantic's `gt=0` and will matter more when you add `seats_available` in the overselling weeks.

**Engine and sessions.**

```python
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# postgresql+psycopg = PostgreSQL dialect with the psycopg 3 driver
engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
```

By default `commit()` *expires* every loaded object, so the next attribute access reloads it from the database. That is safe but surprising in an API: after the commit, serialising the response would trigger fresh SELECTs, or fail if the session is already closed. `expire_on_commit=False` keeps the in-memory values, which the SQLAlchemy docs suggest for web apps. `pool_pre_ping=True` tests each pooled connection before use, which hides the "server closed the connection" error after Postgres restarts.

**`select()` queries.** The 1.x `session.query(Event)` API still works but is legacy. In 2.0 you build a statement and execute it:

```python
from sqlalchemy import select

# by primary key: checks the identity map first, may skip the SQL entirely
event = session.get(Event, event_id)

# list: scalars() unwraps one-entity rows into Event objects
stmt = (
    select(Event)
    .where(Event.starts_at >= now)
    .order_by(Event.starts_at)
    .limit(50)
)
events = list(session.scalars(stmt))

# exactly one or an exception; one_or_none() for optional
event = session.scalars(select(Event).where(Event.title == title)).one()
```

`session.execute(stmt)` returns `Row` tuples; `session.scalars(stmt)` returns the first column of each row, which is what you want when selecting one entity.

**Session per request.** Each request gets a fresh session, commits once if everything succeeded, rolls back otherwise, and always closes (returning the connection to the pool):

```python
from collections.abc import Iterator

from sqlalchemy.orm import Session


def get_session() -> Iterator[Session]:
    with SessionLocal() as session:       # closes on exit
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise                          # never swallow it
```

This puts the transaction boundary at the request edge, so repositories and services never call `commit()` themselves. That matters in week 3: "check seats, decrement, insert booking" must be one transaction, and it only is if no inner layer commits halfway.

**Sync or async?** This week, sync is fine and simpler to debug. `AsyncSession` with `asyncpg` exists and you can migrate later; the model and `select()` code stays the same, only the session calls gain `await`.

**Pitfalls**

- Calling `commit()` inside repositories. Transactions become fragmented and impossible to compose.
- Sharing one `Session` across requests, threads, or asyncio tasks.
- Lazy-loading a relationship after the session is closed: `DetachedInstanceError`. Load what you need inside the request.
- Naive `DateTime` columns for event times.
- Forgetting that `add()` sends nothing: `event.id` is `None` until a flush.
- Unnamed constraints. Name them (`ck_...`, `uq_...`) so Alembic can find and drop them later.

## 4. Alembic migrations

`Base.metadata.create_all()` creates missing tables but never alters existing ones, and it leaves no history. Alembic gives the schema a version history instead. Each migration is a Python file with an `upgrade()` and a `downgrade()` and a pointer to its parent (`down_revision`), so the files form a chain. Alembic records the current revision in a one-row table, `alembic_version`, inside your database. `upgrade head` walks the chain from that revision to the newest file and runs each `upgrade()` in order.

**Init.**

```bash
alembic init migrations            # generic template: alembic.ini + migrations/
alembic list_templates             # also: async, multidb, pyproject (1.16+)
```

You get `alembic.ini` (config), `migrations/env.py` (the script that runs on every Alembic command), `script.py.mako` (the template for new revision files) and `migrations/versions/`.

**Wiring `env.py`.** Two edits matter. Point Alembic at your metadata so autogenerate can compare, and take the URL from your settings so there is one source of truth. Import the models package so every model class has registered its table before Alembic reads `Base.metadata`. A model that is never imported is invisible, and autogenerate would then propose dropping its table.

```python
# migrations/env.py (excerpt; the rest of the generated file stays as is)
from app.core.config import get_settings
from app.core.db import Base
import app.models  # noqa: F401  side effect: registers all models on Base.metadata

config = context.config
config.set_main_option("sqlalchemy.url", get_settings().database_url)
target_metadata = Base.metadata
```

The generated `run_migrations_online()` already passes `target_metadata` to `context.configure(...)`; check it does after your edit.

**Autogenerate.** `alembic revision --autogenerate -m "create events table"` connects to the database, reflects the live schema, diffs it against `target_metadata`, and writes the difference as a new revision file. It is a diff tool, not an oracle. It reliably catches added and removed tables and columns, nullability changes, and (by default since 1.12) column type changes. It does not see:

| Change | What autogenerate produces | What you do |
| --- | --- | --- |
| Rename a column or table | Drop old + add new (data lost) | Rewrite as `op.alter_column(..., new_column_name=...)` / `op.rename_table` |
| Unnamed constraint | Unreliable or missed | Name every constraint |
| Server default changed | Nothing, unless `compare_server_default=True` | Turn it on or hand-write |
| Data backfill needed | Nothing | Add `op.execute(...)` between schema steps |
| Postgres ENUM value added | Nothing useful | Hand-write `ALTER TYPE ... ADD VALUE` |

So the rule is: generate, read the file line by line, fix it, then apply. Treat it as a draft that you own.

Here is what it produced for the `Event` model above (run locally against SQLite, so the server default renders as `CURRENT_TIMESTAMP`; on Postgres it will show `now()`):

```python
def upgrade() -> None:
    op.create_table(
        "events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("venue", sa.String(length=200), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("capacity", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.CheckConstraint("capacity > 0", name="ck_events_capacity_positive"),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("events")
```

Notice `nullable` came straight from `Mapped[str]` vs `Mapped[str | None]`, and the named check constraint survived.

**Moving through history.**

```bash
alembic upgrade head        # apply everything pending
alembic downgrade -1        # undo the latest revision
alembic current             # which revision is the DB at?
alembic history             # list the chain
alembic check               # fails if models and DB differ (good CI guard)
alembic stamp head          # mark as applied WITHOUT running (adopting an existing DB)
```

Test `downgrade` at least once per migration while it is fresh. A downgrade that was never run is a downgrade that does not work.

**Running migrations in Compose.** The database must be healthy before migrations run, and the API should start only on a migrated schema. Two common shapes:

| Option | How | Trade-off |
| --- | --- | --- |
| Entrypoint command | `command: sh -c "alembic upgrade head && uvicorn ..."` | Simplest. With several API replicas, each runs migrations concurrently |
| One-shot `migrate` service | Same image, `command: alembic upgrade head`; API has `depends_on: migrate: condition: service_completed_successfully` | Runs once, clean separation; one more service |
| Manual | `docker compose run --rm api alembic upgrade head` | Full control; easy to forget |

For the capstone the one-shot service is the cleanest because it mirrors how real deployments run migrations as a separate job.

**Pitfalls**

- Models not imported in `env.py`: autogenerate proposes dropping tables.
- Editing a migration that already ran somewhere else. Create a new one instead.
- Two branches each adding a migration with the same parent: `alembic heads` shows two heads. Fix with `alembic merge`.
- Running autogenerate against an empty or wrong database (for example `localhost` vs the Compose port). Check `alembic current` first.
- Mixing `create_all()` in app startup with Alembic. Pick Alembic; keep `create_all()` for throwaway test databases only.

## 5. Project layout: routers, services, repositories

The layout exists to enforce one rule: **dependencies point inward**. HTTP knows about the service; the service knows about the repository interface; nothing below the router knows HTTP exists. Each layer answers one question.

```
event-booking/
├── compose.yaml
├── Dockerfile
├── .env.example
├── alembic.ini
├── migrations/              # env.py, versions/
├── app/
│   ├── main.py              # create app, lifespan, include routers
│   ├── core/
│   │   ├── config.py        # Settings (pydantic-settings)
│   │   └── db.py            # Base, engine, SessionLocal, get_session
│   ├── api/
│   │   ├── deps.py          # Annotated dependency aliases, service factories
│   │   └── events.py        # APIRouter: HTTP in, HTTP out
│   ├── schemas/event.py     # Pydantic: EventCreate, EventRead
│   ├── services/events.py   # use cases: create_event, get_event
│   ├── repositories/events.py  # SQLAlchemy queries for Event
│   └── models/
│       ├── __init__.py      # imports every model (Alembic relies on this)
│       └── event.py         # ORM: Event
└── tests/
    ├── conftest.py
    └── test_events.py
```

| Layer | Knows about | Must not know about | Example |
| --- | --- | --- | --- |
| `api/` router | FastAPI, schemas, services | SQLAlchemy, SQL | Map `EventNotFound` to 404 |
| `schemas/` | Pydantic | ORM, DB | `capacity: int = Field(gt=0)` |
| `services/` | Repositories, models, domain errors | HTTP status codes, `Request` | "Booking needs seats left" |
| `repositories/` | SQLAlchemy `Session`, models | HTTP, business rules | `select(Event).where(...)` |
| `models/` | SQLAlchemy | Everything above | `Event` table mapping |

&#91;embedded content: request path through the layers · session owned by the dependency\]

Calls flow left to right and nothing flows back up: the router knows the service, the service knows the repository, and only the repository talks SQL. The session is created by the dependency, handed down, and committed or rolled back once at the edge of the request.

**Why a repository** (Architecture Patterns with Python, ch. 2). A repository makes storage look like a collection with a tiny interface: `add()`, `get()`, maybe `list()`. Business code then depends on that interface, not on SQL. Two payoffs: you can test services with an in-memory fake, and query details (eager loading, `FOR UPDATE` locks in week 3) live in one place instead of leaking into handlers. The book is honest that for plain CRUD this is mostly overhead; it earns its keep as logic grows, and booking without overselling is exactly that kind of logic.

```python
class EventRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def add(self, event: Event) -> Event:
        self.session.add(event)
        self.session.flush()      # INSERT now so event.id is set; no commit
        return event

    def get(self, event_id: int) -> Event | None:
        return self.session.get(Event, event_id)
```

**Why a service layer** (ch. 4). The service holds use cases: fetch what is needed, check rules, change state, persist. The router shrinks to translation: parse the request, call one service method, turn the result or a domain error into an HTTP response. The same use case can then be driven by a CLI, a Kafka consumer (your notification worker later), or a unit test without HTTP at all.

```python
class EventNotFound(Exception):
    pass


class EventService:
    def __init__(self, repo: EventRepository) -> None:
        self.repo = repo

    def get_event(self, event_id: int) -> Event:
        event = self.repo.get(event_id)
        if event is None:
            raise EventNotFound(event_id)   # domain error, not HTTPException
        return event
```

The service raises a domain exception; the router translates it. Raising `HTTPException` from a service would tie it to the web and break reuse in the Kafka worker.

**Who owns the transaction?** In this setup, the `get_session` dependency does (commit at the end of the request). The book later introduces a Unit of Work (ch. 6) so the service itself controls commit; keep that in mind for the booking weeks, but do not build it yet.

**Pitfalls**

- Pydantic schemas passed into repositories. Repositories take and return ORM models (or primitives).
- Fat routers: queries and rules in the handler "just this once".
- A generic `BaseRepository[T]` with 20 methods on day one. Start with what the use cases need.
- Circular imports between `models` and `core.db`. Keep `Base` in one module that imports nothing from `models`.

## 6. First pytest test: TestClient, fixtures, overrides

`TestClient` (from Starlette, re-exported by FastAPI, built on `httpx`) calls your ASGI app in-process. No server, no port, no network: `client.post("/events", json=...)` goes straight into the app and returns a response object. Plain `def` tests work even though the app is ASGI. If you construct it with `with TestClient(app) as client:`, the lifespan runs on enter and exit; without `with`, startup code does not run.

**Fixtures.** A pytest fixture is a function that builds something a test needs; a test asks for it by parameter name. A fixture that `yield`s gets teardown for free. Put shared fixtures in `tests/conftest.py`; pytest discovers them automatically.

**Overriding a dependency.** `app.dependency_overrides` is a dict: key is the *original* dependency callable used in `Depends(...)`, value is the replacement. FastAPI consults it on every request. This is where the `get_session` design pays off: the endpoint and service code stay untouched while the test points them at a throwaway database.

```python
# tests/conftest.py
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.db import Base, get_session
from app.main import app


@pytest.fixture
def client() -> Iterator[TestClient]:
    # one shared in-memory SQLite DB for this test (StaticPool = one connection)
    engine = create_engine(
        "sqlite+pysqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)

    def override_get_session() -> Iterator[Session]:
        with TestSession() as session:
            yield session
            session.commit()

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()     # don't leak into other tests
```

```python
# tests/test_events.py
def test_unknown_event_returns_404(client) -> None:
    assert client.get("/events/999").status_code == 404


def test_rejects_zero_capacity(client) -> None:
    bad = {"title": "x", "starts_at": "2026-12-01T18:00:00Z", "capacity": 0}
    assert client.post("/events", json=bad).status_code == 422
```

Why `StaticPool`: an in-memory SQLite database lives inside one connection. `TestClient` runs sync endpoints in a worker thread, and SQLite's default pool gives each thread its own connection, which means its own empty database. `StaticPool` hands out the same connection every time, and `check_same_thread=False` lets another thread use it. This only works because tests are serial.

**SQLite or real Postgres?**

| Test database | Speed | Fidelity | Use it for |
| --- | --- | --- | --- |
| SQLite in memory | Very fast, no Docker | Different SQL dialect; no `FOR UPDATE`, different types and constraints | Week 0 smoke tests |
| Postgres in Compose (separate test DB) | Fast enough | Same engine as production | Anything touching transactions, locks, constraints |
| Testcontainers Postgres | Slower startup | Same engine, isolated per run | CI without a shared Compose stack |

For this week SQLite is fine. From the overselling week on, your important tests are about Postgres locking semantics, which SQLite cannot reproduce; switch the fixture to a Postgres test database then.

Note the lifespan in `main.py` still opens a connection on the *production* engine during `with TestClient(app)`. If that database is not running, tests fail at startup. Either run tests inside Compose, or make the startup check skippable through a setting.

**Unit tests without HTTP.** Because the service depends only on something with `add()` and `get()`, a dict-backed fake is enough (the cosmicpython approach). These run in milliseconds:

```python
class FakeEventRepository:
    def __init__(self) -> None:
        self._rows: dict[int, Event] = {}

    def add(self, event: Event) -> Event:
        event.id = len(self._rows) + 1
        self._rows[event.id] = event
        return event

    def get(self, event_id: int) -> Event | None:
        return self._rows.get(event_id)


def test_get_missing_event_raises() -> None:
    service = EventService(FakeEventRepository())
    with pytest.raises(EventNotFound):
        service.get_event(42)
```

To keep a type checker happy, type the service's `repo` parameter as a `typing.Protocol` with `add` and `get`, rather than the concrete class.

**Pitfalls**

- Forgetting `app.dependency_overrides.clear()`. The override leaks into the next test module.
- Overriding a *different* function object than the one in `Depends(...)` (for example a re-wrapped copy). The key must be identical.
- Plain in-memory SQLite without `StaticPool`: "no such table: events".
- Tests depending on each other's data. Each test should create what it reads.
- Asserting only status codes. Also check the body, at least the fields you set.

## Apply it to the capstone

Five tasks, in this order. Each one should end with something you can run. Do not move on until it does.

- [ ] **Task 1:** Compose file with Postgres (healthcheck) and the API service
- [ ] **Task 2:** Project layout
- [ ] **Task 3:** `Event` model and the first Alembic migration
- [ ] **Task 4:** `POST /events` and `GET /events/{id}`
- [ ] **Task 5:** One pytest test that creates and reads an event

### Task 1: Compose with a healthy Postgres

Start from the `compose.yaml` in section 1. Write a minimal Dockerfile:

```dockerfile
FROM python:3.12-slim
WORKDIR /code
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Copy `requirements.txt` before the code so dependency installs are cached across code edits. Pin `fastapi`, `uvicorn[standard]`, `sqlalchemy`, `psycopg[binary]`, `alembic`, `pydantic-settings`, `pytest`, `httpx`.

Done when: `docker compose up -d` then `docker compose ps` shows `db` as `(healthy)` and `curl localhost:8000/docs` returns HTML. Then try `docker compose down && docker compose up -d` and confirm data survives; `down -v` should wipe it.

### Task 2: Layout

Create the tree from section 5 with empty modules. Decide now that `api/` never imports `sqlalchemy`. A quick self-check later: `grep -r sqlalchemy app/api/` should only hit `deps.py`, where the `Session` type is wired.

### Task 3: Model and migration

- Put `Base` in `app/core/db.py` and `Event` in `app/models/event.py`, and import it in `app/models/__init__.py`.
- Fields to start: `id`, `title`, `venue` (nullable), `starts_at` (timezone-aware), `capacity` (named check `> 0`), `created_at` (server default). Do not add `seats_available` yet; you will add it with a second migration in the booking week and practise a real schema change.
- `alembic init migrations`, wire `env.py` (section 4), then `docker compose run --rm api alembic revision --autogenerate -m "create events"`. Running it inside the container means the URL points at `db:5432`, the same database the API uses.
- Read the generated file. Check nullability, the `timestamptz` type, the constraint name. Then `upgrade head`, `downgrade -1`, `upgrade head` again.
- Add a one-shot `migrate` service and gate the API on it:

```yaml
  migrate:
    build: .
    env_file: .env
    environment:
      DATABASE_URL: postgresql+psycopg://booking:booking@db:5432/booking
    command: alembic upgrade head
    depends_on:
      db:
        condition: service_healthy

  api:
    # ...as before, plus:
    depends_on:
      migrate:
        condition: service_completed_successfully
```

Done when: `docker compose exec db psql -U booking booking -c '\d events'` shows the table and `select * from alembic_version` shows your revision id.

### Task 4: The two endpoints

Build bottom-up, one layer at a time: repository (`add`, `get`), then service (`create_event`, `get_event` raising `EventNotFound`), then `deps.py` aliases, then the router. Use the code in sections 2, 3 and 5 as patterns, not as a file to paste. Decisions to make consciously:

- Endpoints are `def`, not `async def`, because the session is sync.
- Where the commit happens. With the `get_session` dependency from section 3, consider `Depends(get_session, scope="function")` so a failed commit becomes a 500 instead of a 201 already sent. Write one sentence in your README explaining your choice.
- `POST` returns 201 with the `EventRead` body; `GET` for a missing id returns 404 with a JSON `detail`.
- Router sketch, to fill in:

```python
@router.get("/{event_id}", response_model=EventRead)
def get_event(event_id: int, service: EventServiceDep):
    try:
        return service.get_event(event_id)
    except EventNotFound:
        ...  # translate the domain error into the HTTP answer
```

Done when: in `/docs`, creating an event returns 201 with an `id`, fetching it returns the same data, and `capacity: 0` returns 422.

### Task 5: The test

Use the `client` fixture from section 6. Write one test that posts an event, reads the `id` from the response, fetches it, and compares at least `title` and `capacity`. Add the 404 case if you have time.

```python
def test_create_then_read_event(client) -> None:
    payload = {"title": "PyCon Astana", "starts_at": "2026-12-01T18:00:00+05:00", "capacity": 300}
    created = client.post("/events", json=payload)
    assert created.status_code == 201
    # fetch it back by id and assert on the body
```

Run it both ways: `pytest` on your laptop and `docker compose run --rm api pytest`. If the laptop run fails at startup, that is the lifespan DB check from section 6 hitting a database it cannot reach; decide how you want to handle it.

**Stretch, only if all five are green:** add `GET /events` with `limit`/`offset` query params; add a `ruff` and `pytest` step to a Makefile; replace the SQLite fixture with a Postgres test database.

## Check yourself

Answer out loud before reading the answers, as you would in an interview.

1. Your API container logs "connection refused" to Postgres on `docker compose up`, but works after a restart. What is happening and what is the proper fix?
2. Why does the API use `db:5432` in its URL while your laptop's psql uses `localhost:5433`?
3. What is the difference between `docker compose down` and `docker compose down -v`, and which one would you run after changing `POSTGRES_PASSWORD`?
4. What does `response_model` do beyond documentation? Give a concrete risk it prevents.
5. Why are the input and output Pydantic models separate, and what does `from_attributes=True` enable?
6. Why is a sync SQLAlchemy session paired with `def` endpoints rather than `async def`?
7. Explain `flush()` vs `commit()`. When would you call `flush()` in a repository?
8. What does `expire_on_commit=False` change, and why is it often used in web apps?
9. Why should repositories and services not call `commit()`? Tie it to the booking feature.
10. Name three things Alembic autogenerate does not handle correctly, and what you do about each.
11. In a test, you set `app.dependency_overrides[get_session] = fake`, but the real database is still hit. Give two possible causes.
12. Why does an in-memory SQLite test database need `StaticPool` with `TestClient`, and why will you leave SQLite behind for the overselling tests?

## Answers

1. Plain `depends_on` only waits for the container to *start*; Postgres is still initialising. Add a `pg_isready` healthcheck to `db` and use `condition: service_healthy`. Retry loops in app code are a fallback, not the fix.
2. Inside the Compose network, services resolve each other by service name and talk on the container port (5432). The laptop reaches Postgres through the published host port (5433 in our mapping). `localhost` inside a container means that container.
3. `down` removes containers and the network but keeps named volumes; `down -v` also deletes them. The Postgres image only applies `POSTGRES_PASSWORD` when initialising an empty data directory, so you need `down -v` (or `ALTER USER`).
4. It filters and validates the return value through the declared model, so undeclared attributes never reach the client. Example: a future `internal_notes` or `owner_password_hash` column on the ORM object is not leaked.
5. Input decides what clients may set (no `id`, no `created_at`); output decides what they see. `from_attributes=True` lets Pydantic read fields from object attributes, so you can return an ORM `Event` directly.
6. A sync session blocks on I/O. FastAPI runs `def` endpoints in a threadpool, so blocking is fine there. Inside `async def` it would block the event loop and stall every concurrent request.
7. `flush()` sends pending SQL inside the open transaction (so generated ids appear) without making it permanent or visible to others. `commit()` flushes then ends the transaction. A repository flushes when the caller needs the new `id` before the request ends.
8. Objects keep their loaded values after commit instead of being expired. Without it, serialising the response after commit triggers new SELECTs, or fails once the session is closed.
9. The transaction boundary should wrap the whole use case. Booking is "lock event row, check seats, decrement, insert booking"; if an inner layer commits halfway, a failure leaves seats decremented without a booking, and locks are released early.
10. Renames (shown as drop + add, losing data: rewrite as `alter_column`/`rename_table`); unnamed constraints (name them); server default changes unless `compare_server_default` is on (enable or hand-write). Also: data migrations, Postgres enum value changes.
11. The key is not the same function object used in `Depends(...)` (imported from a different module or wrapped); or the database is hit outside the dependency, such as the lifespan using the global engine, or code importing `SessionLocal` directly.
12. An in-memory SQLite DB exists per connection, and `TestClient` runs sync endpoints in another thread, which would get a fresh, empty DB. `StaticPool` shares one connection. Overselling tests depend on Postgres row locks, isolation levels and `SELECT ... FOR UPDATE`, which SQLite does not reproduce.

## Sources

Versions checked while writing: FastAPI 0.161, Pydantic 2.13, pydantic-settings 2.16, SQLAlchemy 2.1, Alembic 1.20, pytest 9.1. The code in sections 2 to 6 was run locally against SQLite (5 tests passing, autogenerate and upgrade/downgrade exercised); Postgres-specific parts were checked against the docs only.

- Docker: [Control startup order in Compose](https://docs.docker.com/compose/how-tos/startup-order/)
- Docker: [Compose services reference](https://docs.docker.com/reference/compose-file/services/)
- Docker: [Version and name top-level elements](https://docs.docker.com/reference/compose-file/version-and-name/)
- Docker: [Variable interpolation and .env](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)
- docker-library: [Postgres 18 volume mount path change (issue 1370)](https://github.com/docker-library/postgres/issues/1370)
- FastAPI: [Lifespan events](https://fastapi.tiangolo.com/advanced/events/)
- FastAPI: [Dependencies with yield](https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-with-yield/)
- FastAPI: [Testing dependencies with overrides](https://fastapi.tiangolo.com/advanced/testing-dependencies/)
- FastAPI: [Testing lifespan events](https://fastapi.tiangolo.com/advanced/testing-events/)
- SQLAlchemy: [Session basics](https://docs.sqlalchemy.org/en/20/orm/session_basics.html)
- SQLAlchemy: [Declarative table configuration](https://docs.sqlalchemy.org/en/20/orm/declarative_tables.html)
- SQLAlchemy: [SQLite dialect, threading and pooling](https://docs.sqlalchemy.org/en/20/dialects/sqlite.html)
- Alembic: [Tutorial](https://alembic.sqlalchemy.org/en/latest/tutorial.html)
- Alembic: [Auto generating migrations](https://alembic.sqlalchemy.org/en/latest/autogenerate.html)
- Architecture Patterns with Python: [Ch. 2, Repository pattern](https://www.cosmicpython.com/book/chapter_02_repository.html)
- Architecture Patterns with Python: [Ch. 4, Service layer](https://www.cosmicpython.com/book/chapter_04_service_layer.html)
