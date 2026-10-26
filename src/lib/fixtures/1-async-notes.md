# Study Notes — Week 1: Async Python

Oct 23, 2026 · @Mathew Matholomew

After this week you will know what the asyncio event loop actually does at each `await`, why one blocking call can stall every request in a FastAPI app, and how to run, limit, time out and cancel concurrent work safely. You will turn the event-booking API into a fully async service (async endpoints, `AsyncSession` over asyncpg), build an in-process queue worker that later becomes the `booking.created` Kafka consumer, and test it all with pytest-asyncio and httpx.

## 1. Concurrency, parallelism and the GIL

Async gives you concurrency, not parallelism: many tasks make progress by taking turns on one thread, and the win comes only while they wait on I/O.

**Concurrency** means several tasks are in flight at once and their lifetimes overlap. **Parallelism** means several tasks execute instructions at the same instant, on different CPU cores. A single cook who puts pasta on to boil and chops onions while it heats is concurrent. Two cooks are parallel.

Python offers three tools, and they differ in who decides when to switch and what can run truly in parallel.

- **Threads** are scheduled by the OS. The OS can switch threads at any moment (pre-emptive), so shared data needs locks. In standard CPython, the **Global Interpreter Lock (GIL)** lets only one thread run Python bytecode at a time. A thread releases the GIL when it blocks on I/O (socket read, `time.sleep`, many C extensions), so threads work fine for I/O-bound code but give no speed-up for pure-Python CPU work.
- **Processes** each have their own interpreter, memory and GIL. They give real parallelism for CPU work, at the cost of startup time, more memory and pickling every argument and result across the process boundary.
- **asyncio** runs many coroutines on **one thread**. Switching is cooperative: a coroutine gives up control only at an `await`. No pre-emption means no surprise interleaving between two `await`s, so most races disappear. The flip side: one coroutine that never awaits freezes everyone else.

Why is async cheaper than threads for I/O? A thread costs an OS stack (often megabytes of reserved virtual memory) and a kernel context switch. A suspended coroutine is just a Python object holding its frame, a few KB. Ten thousand idle WebSocket connections are fine as coroutines and painful as threads.

### The GIL in 2026: free-threaded builds

[PEP 703](https://peps.python.org/pep-0703/) made the GIL optional. A separate **free-threaded build** shipped as experimental in 3.13. [PEP 779](https://peps.python.org/pep-0779/) (accepted June 2025) moved it to "phase II" in 3.14: officially supported, but **still optional and not the default**. No date is set for making it the default; that needs a future PEP.

Practical facts from the [free-threading HOWTO](https://docs.python.org/3/howto/free-threading-python.html):

- The official macOS and Windows installers can install the free-threaded binaries; from source you build with `--disable-gil`.
- Check the build with `sysconfig.get_config_var("Py_GIL_DISABLED")` and the runtime state with `sys._is_gil_enabled()`.
- Importing a C extension not marked as free-threading safe turns the GIL back on, with a warning.
- Single-threaded code runs somewhat slower: roughly 1% on macOS arm64 and up to about 8% on x86-64 Linux.

For this course, assume the normal GIL build. Your Docker images will use standard CPython, and async is about I/O anyway.

### When async helps, and when it does not

| Workload | Example in the booking API | Best tool | Why |
| --- | --- | --- | --- |
| Many slow network waits | DB queries, Redis, Kafka, HTTP calls to a payment provider | asyncio | One thread juggles thousands of waits cheaply |
| Blocking library you cannot replace | A sync SDK, `requests`, file I/O | Thread pool (`asyncio.to_thread`) | The blocking call releases the GIL while waiting |
| CPU-heavy pure Python | Generating a PDF ticket, hashing, resizing images | Process pool | Only separate processes bypass the GIL (on the default build) |
| CPU work in C that releases the GIL | NumPy, some crypto | Threads can work | The C code runs outside the GIL |

Rule of thumb: async multiplies *waiting*, it does not multiply *computing*. If a request spends 95% of its time waiting on Postgres, async lets one worker serve many such requests. If it spends 95% computing, async adds nothing and a blocking CPU task will even hurt latency for everyone (section 5).

```python
import asyncio
import time


async def fake_query(ms: int) -> int:
    await asyncio.sleep(ms / 1000)  # stands in for a DB round trip
    return ms


async def main() -> None:
    start = time.perf_counter()
    results = await asyncio.gather(*(fake_query(200) for _ in range(100)))
    elapsed = time.perf_counter() - start
    print(f"{len(results)} queries in {elapsed:.2f}s")  # ~0.20s, not 20s


asyncio.run(main())
```

**Pitfalls**

- Assuming async makes code faster. It makes *waiting* overlap; a single request is not faster.
- Thinking the GIL makes your code thread-safe. It protects interpreter internals, not your invariants; `counter += 1` across threads can still lose updates.
- Reaching for processes for I/O work. You pay pickling and memory for nothing.
- Assuming free-threading is on in production images. It is an opt-in build; check before you rely on it.

## 2. How the event loop works

The event loop is a `while True` that runs whichever task is ready, and an `await` on unfinished I/O is the point where a task hands control back to that loop.

### Coroutines are suspendable functions

Calling an `async def` function does **not** run its body. It returns a coroutine object: a paused frame with its locals and a pointer to the next instruction. Something must drive it. Under the hood a coroutine is a generator in disguise; it can be advanced with `.send(None)`, and every chain of `await`s ends in a plain `yield` deep inside asyncio. That `yield` is how a coroutine says "I can't continue yet".

```python
import types


@types.coroutine
def suspend():
    yield "waiting on I/O"  # every await chain bottoms out in a yield like this


async def reserve_seat(event_id: int) -> str:
    print("checking availability")
    await suspend()
    print("writing booking")
    return f"booking for event {event_id}"


coro = reserve_seat(42)      # nothing printed yet
print(coro.send(None))       # runs to the yield -> "waiting on I/O"
try:
    coro.send(None)          # resumes after the await
except StopIteration as stop:
    print(stop.value)        # the return value travels in StopIteration
```

You never do this by hand in real code. It shows that the loop is just code calling `send()` on coroutines when they can make progress.

### What happens at an `await`

Take `row = await conn.fetchrow("SELECT ...")` with asyncpg:

1. The driver writes the query to the socket. Writing is fast; the reply is not there yet.
2. The driver creates a **Future**: a placeholder for a result that will arrive later. It asks the loop to watch the socket for readability.
3. Your coroutine awaits that Future. Since it is not done, the `yield` travels up through every `await` to the **Task** that drives your coroutine. Your frame is now frozen.
4. The Task returns to the loop. The loop runs other ready callbacks: other requests, timers.
5. When nothing is ready, the loop calls the OS **selector** (`epoll` on Linux, `kqueue` on macOS) with a timeout equal to the next scheduled timer. The thread sleeps in the kernel, using no CPU.
6. Postgres replies. The kernel marks the socket readable, `epoll` returns, the loop runs the driver's read callback, which parses the row and calls `future.set_result(row)`.
7. Completing the Future schedules the waiting Task to run on the next loop iteration. The Task calls `send()` on your coroutine, `await` returns `row`, and your code continues.

&#91;embedded content: event loop cycle · 4 stages\]

Read it clockwise: the loop only ever runs one task step at a time, and the highlighted step is the only place your code executes, so a step that never reaches an await stalls the whole cycle.

An `await` on something that is already finished does **not** yield to the loop. Awaiting a coroutine directly is just a function call that may suspend. That is why `await other_coroutine()` gives no concurrency on its own.

### Coroutines, Tasks and Futures

| Object | What it is | Who creates it | Runs on its own? |
| --- | --- | --- | --- |
| Coroutine | A paused `async def` frame | Calling an `async def` | No; nothing happens until awaited or wrapped in a Task |
| Future | A low-level slot for a result plus done-callbacks | Libraries, `loop.create_future()` | Not code; something else sets its result |
| Task | A Future subclass that drives one coroutine step by step | `asyncio.create_task`, `TaskGroup.create_task`, `gather` | Yes, scheduled on the loop immediately |

A Task is the unit of concurrency. Two coroutines run concurrently only if each is inside its own Task. `asyncio.run(main())` wraps `main()` in the first Task, runs the loop until it finishes, then closes the loop.

**Pitfalls**

- Calling `fetch()` without `await`. You get a never-awaited coroutine warning and no work happens.
- Expecting `await a(); await b()` to overlap. It is sequential; you need Tasks.
- Calling `asyncio.run()` inside code already running on a loop (for example, inside a FastAPI handler). It raises `RuntimeError`; just `await`.
- Believing `async def` alone makes code non-blocking. Only awaiting real async I/O yields; a loop of pure Python inside `async def` blocks everyone.

## 3. Running things concurrently

Use `TaskGroup` by default, `gather(return_exceptions=True)` when partial failure is acceptable, `as_completed` when you want results as they land, and a `Semaphore` to cap how many run at once.

### `create_task`: start now, collect later

`asyncio.create_task(coro)` wraps the coroutine in a Task and schedules it. It starts running at the creator's next `await`. You get a handle to await later, cancel, or check.

Two rules matter. First, the loop keeps only a **weak reference** to tasks, so a task you do not store can be garbage-collected mid-flight. Second, an exception in a task nobody awaits is only logged as "Task exception was never retrieved", long after the fact. Both rules push you towards structured concurrency.

### Structured concurrency with `TaskGroup` (3.11+)

Structured concurrency means a child task cannot outlive the block that started it. `asyncio.TaskGroup` enforces this:

- Leaving the `async with` block waits for every child.
- If a child raises (anything except `CancelledError`), the group cancels its other children and the body, waits for them, then raises an `ExceptionGroup` with every failure.
- The group holds strong references, so nothing is lost or silently dropped.

```python
import asyncio
from dataclasses import dataclass


@dataclass
class Event:
    id: int
    title: str


async def load_event(event_id: int) -> Event:
    await asyncio.sleep(0.1)  # simulated DB call
    return Event(event_id, f"Concert #{event_id}")


async def load_seats_left(event_id: int) -> int:
    await asyncio.sleep(0.1)
    return 120


async def event_page(event_id: int) -> dict[str, object]:
    async with asyncio.TaskGroup() as tg:
        event = tg.create_task(load_event(event_id))
        seats = tg.create_task(load_seats_left(event_id))
    # both are done here; total time ~0.1s, not 0.2s
    return {"event": event.result(), "seats_left": seats.result()}
```

Handle failures with `except*`, which matches exceptions inside the group:

```python
try:
    async with asyncio.TaskGroup() as tg:
        tg.create_task(load_event(1))
        tg.create_task(call_weather_api("Astana"))  # raises ConnectionError
except* ConnectionError as eg:
    log.warning("page degraded: %s", eg.exceptions)
```

### `gather` and `return_exceptions`

`asyncio.gather(*aws)` runs awaitables concurrently and returns results **in argument order**. Its failure behaviour is the trap:

- Default (`return_exceptions=False`): the first exception propagates to you, but the other awaitables are **not cancelled**. They keep running unattended.
- `return_exceptions=True`: exceptions are returned in the results list like values. Nothing propagates, so you must check each item.
- If the `gather` itself is cancelled, it cancels all its children.

`gather(..., return_exceptions=True)` fits "best effort" work: load the event, and the weather widget is optional.

```python
event, weather = await asyncio.gather(
    load_event(event_id), call_weather_api("Astana"), return_exceptions=True
)
if isinstance(event, BaseException):
    raise event                      # the event is mandatory
weather = None if isinstance(weather, Exception) else weather
```

### `as_completed`: handle results in finish order

Since Python 3.13 `as_completed` is also an **async iterator** that yields the original tasks, so you can tell which one finished. Plain iteration still works and yields fresh coroutines, as before 3.13. Its `timeout` raises `TimeoutError` but does not cancel the remaining tasks; you clean them up.

```python
tasks = [asyncio.create_task(send_reminder(user_id)) for user_id in user_ids]
async for task in asyncio.as_completed(tasks):
    print("reminder sent to", await task)
```

### Limiting concurrency with `Semaphore`

Starting 500 tasks is cheap. Opening 500 sockets to one host, or 500 connections to a pool of 20, is not. A `Semaphore(n)` is a counter: `async with sem` decrements it, waits if it is zero, and increments on exit. At most `n` coroutines are inside the block.

```python
async def fetch_all(urls: list[str], limit: int = 20) -> list[str]:
    sem = asyncio.Semaphore(limit)

    async def fetch_one(url: str) -> str:
        async with sem:              # at most `limit` bodies run at once
            await asyncio.sleep(0.01)  # real code: await client.get(url)
            return url

    async with asyncio.TaskGroup() as tg:
        tasks = [tg.create_task(fetch_one(u)) for u in urls]
    return [t.result() for t in tasks]
```

| Tool | Result order | On first failure | Best for |
| --- | --- | --- | --- |
| `TaskGroup` | You hold each task | Cancels siblings, raises `ExceptionGroup` | Default; all parts required |
| `gather` | Argument order | Raises first error, siblings keep running | Quick fan-out; with `return_exceptions=True` for best effort |
| `as_completed` | Finish order | Raised when you await that task | Streaming results, progress |
| `Semaphore` | n/a | n/a | Capping in-flight work inside any of the above |

**Pitfalls**

- Fire-and-forget `create_task` without keeping a reference. Store it in a set and discard it in a done-callback, or use a TaskGroup.
- Using `gather` without `return_exceptions` and assuming failure stops the rest. It does not.
- Mixing up `ExceptionGroup` and plain exceptions. `except ValueError` does not catch a group; use `except*`.
- Creating the `Semaphore` inside each task. Every task gets its own counter and nothing is limited.

## 4. Timeouts, cancellation and cleanup

In asyncio a timeout *is* a cancellation: the loop throws `CancelledError` into the task at its current `await`, so every timeout depends on your code letting that exception travel up.

### How cancellation works

`task.cancel()` does not stop anything immediately. It marks the task and, the next time the task is resumed, raises `asyncio.CancelledError` at the `await` where it is suspended. From there it is an ordinary exception: `except` blocks and `finally` blocks run, and if it reaches the top of the coroutine the task ends in the *cancelled* state.

`CancelledError` inherits from `BaseException`, not `Exception`, since Python 3.8. So `except Exception:` does not catch it. That is deliberate: generic error handlers must not accidentally stop a cancellation.

### `asyncio.timeout` (3.11+)

`async with asyncio.timeout(seconds):` sets a deadline for the block. When it expires, the context manager cancels the current task, then converts the resulting `CancelledError` into `TimeoutError` as it leaves the block. Catch `TimeoutError` outside the block. `asyncio.timeout_at(when)` takes an absolute loop time, and `cm.reschedule()` moves the deadline.

```python
async def charge(booking_id: int) -> PaymentResult | None:
    try:
        async with asyncio.timeout(2.0):
            return await payment_client.charge(booking_id)
    except TimeoutError:
        log.warning("payment for booking %s timed out", booking_id)
        return None
```

`asyncio.wait_for(aw, timeout)` still exists and does the same for one awaitable. Prefer `timeout()` for blocks with several awaits.

### Never swallow `CancelledError`

If you catch it, do your cleanup and **re-raise**. Swallowing it breaks timeouts, TaskGroups and shutdown. I verified this: a coroutine that catches and ignores `CancelledError` inside `asyncio.timeout(0.05)` keeps running, and the `TimeoutError` never arrives.

```python
async def hold_seat(conn: Connection, seat_id: int) -> None:
    await conn.execute("UPDATE seats SET held = true WHERE id = $1", seat_id)
    try:
        await wait_for_payment(seat_id)
    except asyncio.CancelledError:
        log.info("hold for seat %s cancelled", seat_id)
        raise                       # always re-raise
    finally:
        await release_if_unpaid(conn, seat_id)  # runs on success, error, cancel
```

Use `finally` (or `async with`) for cleanup. It runs whether the task finishes, fails or is cancelled. If you truly must suppress a cancellation, the docs say you must also call `task.uncancel()`; application code almost never should.

### Shielding

`await asyncio.shield(task)` protects the *inner* task from a cancellation aimed at the *outer* one. The awaiting coroutine still gets `CancelledError`, but the inner task keeps running. Use it for short work that must finish once started, such as writing an audit row after a payment succeeded. Keep a reference to the inner task, or it may be garbage-collected.

```python
audit_task = asyncio.create_task(write_audit_log(booking_id))
background_tasks.add(audit_task)
audit_task.add_done_callback(background_tasks.discard)
await asyncio.shield(audit_task)   # caller may be cancelled; audit still completes
```

### Cancellation inside a TaskGroup

When one child fails, the group cancels the siblings and the body. Each sibling sees `CancelledError` at its current await, runs its `finally` blocks, and ends. The group then raises an `ExceptionGroup` holding only the real failures. If the task that owns the group is cancelled from outside, the group cancels every child and then lets the `CancelledError` propagate. Python 3.15 adds `TaskGroup.cancel()` for a clean early exit without raising.

**Pitfalls**

- `except BaseException:` or bare `except:` around an await, without re-raising. Same bug as swallowing `CancelledError`.
- Assuming a timeout stops blocking code. It cannot interrupt `time.sleep()` or a sync driver; cancellation only lands at an `await`.
- Long awaits inside `finally`. Shutdown waits on them; keep cleanup short or give it its own timeout.
- Shielding everything. A shielded task that hangs can never be cancelled by its caller.

## 5. Blocking the loop

Any code that runs for a long time without reaching an `await` freezes every other task on that loop; the fix is to move it to a thread (blocking I/O) or a process (CPU work).

### What counts as blocking

The loop has one thread. While your coroutine runs Python code, the loop cannot poll sockets, fire timers or resume anyone else. So "blocking" means anything that holds the thread for more than a few milliseconds:

- `time.sleep()` instead of `await asyncio.sleep()`.
- Sync network clients: `requests`, `psycopg2`, sync `redis`, `boto3`, most vendor SDKs.
- Sync SQLAlchemy `Session` calls inside `async def`.
- File I/O on big files, `subprocess.run`.
- CPU work: password hashing with bcrypt or argon2, PDF or QR generation, big JSON serialisation, pandas.

The damage is multiplied. If one handler sleeps 1 second, every concurrent request on that worker waits too, including health checks.

### Detecting it

Turn on asyncio **debug mode**: `PYTHONASYNCIODEBUG=1`, `python -X dev`, or `asyncio.run(main(), debug=True)`. Among other checks, it logs any callback or task step that runs longer than `loop.slow_callback_duration`, which defaults to 100 ms. The warning goes to the `asyncio` logger and names the task, as in "Executing \<Task ...> took 0.301 seconds" from my test run.

A cheap production-friendly detector is a **heartbeat** task: sleep 10 ms in a loop and record how late you wake up. Late wake-ups mean someone held the loop.

```python
async def loop_lag_monitor(interval: float = 0.01) -> None:
    loop = asyncio.get_running_loop()
    while True:
        start = loop.time()
        await asyncio.sleep(interval)
        lag = loop.time() - start - interval
        if lag > 0.1:
            log.warning("event loop lagged %.0f ms", lag * 1000)
```

In my run, a `time.sleep(0.3)` inside a coroutine produced a 308 ms gap in the heartbeat. The same sleep via `asyncio.to_thread` produced about 20 ms.

### Fixing it

| Situation | Fix | Why it works |
| --- | --- | --- |
| An async library exists | Switch: `httpx.AsyncClient`, asyncpg, `redis.asyncio`, aiokafka | Waits become real `await`s |
| Blocking I/O you must keep | `await asyncio.to_thread(func, *args)` | Runs in the loop's default thread pool; the GIL is released during the I/O wait |
| Need a specific pool | `await loop.run_in_executor(pool, func, *args)` | Same mechanism, your own executor and size |
| CPU-bound pure Python | `run_in_executor(ProcessPoolExecutor(), func, *args)` | Separate process, separate GIL |

`asyncio.to_thread` also copies the current `contextvars` context into the thread, so request IDs in logging context survive. The default thread pool has `min(32, cpu_count + 4)` workers (3.13 uses `process_cpu_count`), so do not push thousands of blocking calls at it at once.

```python
import asyncio
from concurrent.futures import ProcessPoolExecutor

from argon2 import PasswordHasher  # sync and CPU-heavy

hasher = PasswordHasher()
cpu_pool = ProcessPoolExecutor(max_workers=2)  # create once, in lifespan


async def register_user(email: str, password: str) -> None:
    loop = asyncio.get_running_loop()
    pw_hash = await loop.run_in_executor(cpu_pool, hasher.hash, password)
    await users_repo.create(email=email, password_hash=pw_hash)


async def fetch_legacy_rates(url: str) -> dict:
    import requests  # a sync client you can't replace yet
    resp = await asyncio.to_thread(requests.get, url, timeout=5)
    return resp.json()
```

Functions sent to a process pool must be importable top-level callables, and arguments and results must pickle. Since 3.14 the default process start method on Linux is no longer `fork`, so module-level setup may run again in workers.

**Pitfalls**

- `async def` endpoints that call sync libraries. This is the worst case in FastAPI: it blocks the loop, whereas plain `def` would have used a thread.
- Wrapping a coroutine in `to_thread`. It expects a sync callable; pass the function, not `func()`.
- Expecting `asyncio.timeout` to cut a thread short. The await times out, but the thread keeps running to completion.
- Creating a new `ProcessPoolExecutor` per request. Startup costs dominate; create one in lifespan and shut it down there.

## 6. Async in FastAPI and SQLAlchemy

FastAPI runs `async def` endpoints on the event loop and plain `def` endpoints in a thread pool; pick `async def` only when everything inside it awaits, and use SQLAlchemy's async API so database calls really await.

### `def` vs `async def` endpoints

FastAPI sits on Starlette, which sits on AnyIO. For each request:

- An `async def` path function is awaited **directly on the loop**. Fast, no thread hop, but any blocking call inside it stalls the whole worker.
- A plain `def` path function is sent to a **thread pool** via `anyio.to_thread.run_sync` and awaited. Blocking inside it only blocks that thread. AnyIO's default limiter allows **40** such threads at once; request 41 waits for a free thread.
- Dependencies follow the same rule: `def` dependencies run in the pool, `async def` ones on the loop.

| Endpoint body | Declare as | What happens under load |
| --- | --- | --- |
| Only `await`s async libraries | `async def` | Thousands of concurrent requests on one worker |
| Calls sync libraries (requests, psycopg2, sync Session) | `def` | Up to 40 run in parallel threads; then they queue |
| Sync library inside `async def` | Never | Every request on the worker serialises behind it |
| Mostly async, one blocking call | `async def` + `await asyncio.to_thread(...)` for that call | Loop stays free |

### Dependencies with `yield`

A dependency that yields is a context manager: code before `yield` is setup, code after is teardown. FastAPI's default is to run teardown **after the response is sent**. You can pass `Depends(dep, scope="function")` to run teardown right after the path function returns instead. If you catch an exception in a yield dependency, re-raise it, or the server logs nothing about the error.

### Lifespan

Create expensive shared resources once per process, not per request. Pass an `@asynccontextmanager` function as `FastAPI(lifespan=...)`: setup before `yield`, teardown after. The old `@app.on_event("startup")` hooks are deprecated, and if you pass `lifespan` they are not called at all.

### Async SQLAlchemy 2.x

The pieces, with the PostgreSQL driver asyncpg:

- `create_async_engine("postgresql+asyncpg://user:pass@db:5432/booking")` builds an engine with an async connection pool.
- `async_sessionmaker(engine, expire_on_commit=False)` is the session factory. Create it once.
- `AsyncSession` is one unit of work. Use one per request, and never share one between concurrent tasks; the docs state it is not safe for that.
- `await engine.dispose()` at shutdown closes pooled connections cleanly.

Why `expire_on_commit=False`? By default, `commit()` expires every loaded object, so the next attribute access reloads it from the DB. In sync code that reload happens silently. In async code an attribute access cannot `await`, so the reload fails. Turning expiry off keeps the committed values readable, for example when you return the new booking in the response.

```python
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException
from sqlalchemy import ForeignKey, select
from sqlalchemy.ext.asyncio import (
    AsyncAttrs, AsyncSession, async_sessionmaker, create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, selectinload

engine = create_async_engine(settings.database_url, pool_size=10, pool_pre_ping=True)
SessionFactory = async_sessionmaker(engine, expire_on_commit=False)


class Base(AsyncAttrs, DeclarativeBase):
    pass


class Event(Base):
    __tablename__ = "events"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str]
    capacity: Mapped[int]
    bookings: Mapped[list["Booking"]] = relationship(back_populates="event", lazy="raise")


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionFactory() as session:   # closed after the response
        yield session


SessionDep = Annotated[AsyncSession, Depends(get_session)]


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    yield                     # app serves requests here
    await engine.dispose()    # close pooled connections on shutdown


app = FastAPI(lifespan=lifespan)


@app.get("/events/{event_id}")
async def read_event(event_id: int, session: SessionDep) -> dict[str, object]:
    stmt = (
        select(Event)
        .where(Event.id == event_id)
        .options(selectinload(Event.bookings))   # load now, in this await
    )
    event = (await session.scalars(stmt)).one_or_none()
    if event is None:
        raise HTTPException(status_code=404, detail="event not found")
    return {"id": event.id, "title": event.title, "booked": len(event.bookings)}
```

### The lazy-loading trap

In sync SQLAlchemy, touching `event.bookings` quietly runs a SELECT. In async code that would be hidden I/O inside a normal attribute access, which cannot await. SQLAlchemy refuses: I reproduced it on SQLAlchemy 2.1 and got `MissingGreenlet` ("greenlet\_spawn has not been called"). Fixes, in order of preference:

1. Eager-load what the endpoint needs: `selectinload()` for collections, `joinedload()` for many-to-one.
2. Set `lazy="raise"` on relationships so a forgotten eager load fails loudly in tests, not in production.
3. Load on purpose: `await event.awaitable_attrs.bookings` (needs the `AsyncAttrs` mixin) or `await session.refresh(event, ["bookings"])`.

**Pitfalls**

- `async def` endpoint plus a sync DB driver. Pick one model: all async (asyncpg) or `def` endpoints with sync drivers.
- One `AsyncSession` shared across `TaskGroup` children. Give each concurrent task its own session from the factory.
- Forgetting `expire_on_commit=False`, then reading attributes after `commit()`.
- Creating the engine per request. It owns the pool; create it once at import or in lifespan.
- Lifespan on mounted sub-apps. It runs only for the main application.

## 7. Async context managers, generators and queues

An `asyncio.Queue` between a producer and a pool of consumers, wrapped in async context managers for setup and teardown, is the exact shape of the Kafka notification worker you build later.

### Async context managers and generators

`async with` calls `await obj.__aenter__()` and `await obj.__aexit__(...)`, so both setup and teardown can do I/O: open a connection, commit or roll back a transaction, close a client. `@asynccontextmanager` lets you write one as a single generator function, with `try/finally` around the `yield` so teardown runs even on error or cancellation.

An **async generator** is an `async def` that uses `yield`. You consume it with `async for`, and it can `await` between items. It is the natural shape for "a stream of things that arrive over time": rows from a server-side cursor, messages from Kafka, pages from a paginated API.

```python
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass


@dataclass(frozen=True)
class BookingCreated:
    booking_id: int
    user_email: str


@asynccontextmanager
async def open_mailer(dsn: str) -> AsyncIterator[Mailer]:
    mailer = Mailer(dsn)
    await mailer.connect()
    try:
        yield mailer
    finally:
        await mailer.close()       # runs on success, error and cancellation


async def pending_notifications(session: AsyncSession) -> AsyncIterator[BookingCreated]:
    result = await session.stream(select(Booking).where(Booking.notified.is_(False)))
    async for booking in result.scalars():
        yield BookingCreated(booking.id, booking.user_email)
```

### Producer/consumer with `asyncio.Queue`

`asyncio.Queue` is a FIFO for tasks on one loop (it is not thread-safe). Its key behaviours:

- `await queue.put(x)` waits when the queue is full. A bounded `maxsize` gives you **backpressure**: a fast producer slows to the speed of the consumers instead of filling memory.
- `await queue.get()` waits when empty.
- Each `get()` must be matched by one `task_done()`. `await queue.join()` waits until every item put so far has been marked done.
- Since 3.13, `queue.shutdown()` closes the queue: further `put()` raises `QueueShutDown`, and `get()` raises it once the queue is empty. With `immediate=True` it also drops the remaining items. On 3.12, put one sentinel (`None`) per consumer instead.

```python
import asyncio


async def consumer(name: str, queue: asyncio.Queue[BookingCreated], mailer: Mailer) -> None:
    while True:
        try:
            event = await queue.get()
        except asyncio.QueueShutDown:      # 3.13+; closed and drained
            return
        try:
            await mailer.send(event.user_email, f"Booking {event.booking_id} confirmed")
        except Exception:
            log.exception("notify failed for booking %s", event.booking_id)
        finally:
            queue.task_done()              # always, or join() hangs forever


async def run_notifier(events: AsyncIterator[BookingCreated]) -> None:
    queue: asyncio.Queue[BookingCreated] = asyncio.Queue(maxsize=100)
    async with open_mailer(settings.smtp_dsn) as mailer:
        async with asyncio.TaskGroup() as tg:
            for i in range(3):
                tg.create_task(consumer(f"worker-{i}", queue, mailer))
            async for event in events:
                await queue.put(event)     # backpressure when consumers lag
            await queue.join()             # every event processed
            queue.shutdown()               # idle consumers wake up and exit
```

### Graceful shutdown

In Docker, `docker compose stop` sends SIGTERM and kills the process after a grace period (10 s by default). Graceful means: stop taking new work, finish or hand back what is in flight, release resources, exit before the kill. With asyncio:

1. Register `loop.add_signal_handler(signal.SIGTERM, stop_event.set)` (Unix only).
2. The producer loop checks `stop_event` and stops reading new input.
3. Call `queue.shutdown()`. Consumers finish the items already queued, then get `QueueShutDown` and return.
4. The TaskGroup exits once all consumers return; the `async with` blocks close the mailer and DB engine.
5. Wrap the drain in `asyncio.timeout(...)` shorter than the grace period. If it expires, the TaskGroup cancels consumers, and their `finally` blocks still run.

For Kafka the same skeleton holds. The source becomes `async for msg in consumer` from aiokafka, and you commit offsets only after `task_done`, so an unfinished message is redelivered after a restart.

**Pitfalls**

- Forgetting `task_done()` on the error path. `join()` never returns. Put it in `finally`.
- Unbounded queues (`maxsize=0`). A slow consumer turns into a memory leak.
- Letting one bad message raise out of the consumer loop. In a TaskGroup that cancels every worker.
- Using `asyncio.Queue` across threads. Use `loop.call_soon_threadsafe(queue.put_nowait, item)` from the other thread, or a `queue.Queue`.

## 8. Testing async code

pytest-asyncio runs `async def` tests on an event loop it manages, and `httpx.AsyncClient` with `ASGITransport` calls your FastAPI app in-process, on that same loop, with no server and no sockets.

### pytest-asyncio: modes and loop scope

Plain pytest does not know how to run a coroutine function; it would just create the coroutine and warn. pytest-asyncio (1.4.0 at the time of writing) adds that. Two modes, set with `asyncio_mode` in config or `--asyncio-mode`:

| Mode | What you write | When to use |
| --- | --- | --- |
| `strict` (default) | `@pytest.mark.asyncio` on tests, `@pytest_asyncio.fixture` on async fixtures | Projects that also use another async plugin (trio, anyio) |
| `auto` | Nothing; every `async def` test and fixture is handled | Pure-asyncio projects like the capstone |

**Loop scope** decides how long one event loop lives. By default each test gets a fresh loop. That isolation is good, but an async fixture can only be used by tests on the **same loop** that created it. A session-scoped engine or connection pool created on loop A and then used from loop B fails with errors such as "attached to a different loop".

- Per test: `@pytest.mark.asyncio(loop_scope="module")` or `"session"`.
- Per fixture: `@pytest_asyncio.fixture(loop_scope="session", scope="session")`.
- Defaults: `asyncio_default_fixture_loop_scope` and `asyncio_default_test_loop_scope` in config. Set the fixture one explicitly; leaving it unset triggers a warning about future defaults.

The old `event_loop` fixture was removed in pytest-asyncio 1.0. Old blog posts that override it no longer apply.

```toml
# pyproject.toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "session"
asyncio_default_test_loop_scope = "session"
```

Using one session-wide loop is the simplest setup when an engine is shared across tests; isolate data with a transaction per test instead of a loop per test.

### httpx.AsyncClient + ASGITransport

`ASGITransport(app=app)` makes httpx call the ASGI app directly instead of opening a socket. Pair it with `AsyncClient(transport=..., base_url="http://test")`. Two facts matter:

- It does **not** run lifespan events. Either enter your lifespan yourself or use `LifespanManager` from the `asgi-lifespan` package.
- App exceptions are re-raised into the test by default. Pass `raise_app_exceptions=False` to get a 500 response instead.

```python
from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient

from booking.main import app, lifespan


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    async with lifespan(app):   # run startup/shutdown ourselves
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


async def test_create_and_read_event(client: AsyncClient) -> None:
    created = await client.post("/events", json={"title": "Jazz night", "capacity": 50})
    assert created.status_code == 201
    event_id = created.json()["id"]

    fetched = await client.get(f"/events/{event_id}")
    assert fetched.status_code == 200
    assert fetched.json()["title"] == "Jazz night"
```

This runs in auto mode. I checked the same pattern in strict mode with the explicit markers and with `loop_scope="module"`; both pass on pytest 9.1 and pytest-asyncio 1.4.

To test concurrency itself, fire requests together with `asyncio.gather(*(client.post(...) for _ in range(20)))` and assert on the outcome, for example that only `capacity` bookings succeed. Note that in-process calls share one loop with the app, so a blocking handler blocks the test too; real latency experiments belong against a running server.

Override the DB dependency for tests with `app.dependency_overrides[get_session] = override` to point at a test database.

**Pitfalls**

- Async fixtures in strict mode decorated with `@pytest.fixture`. They are not awaited; use `@pytest_asyncio.fixture` or switch to auto mode.
- A session-scoped engine fixture with function-scoped loops. Align the loop scopes.
- Expecting `ASGITransport` to run startup code. It does not.
- Using `TestClient` inside async tests. It runs its own loop in a thread; use `AsyncClient` in async tests.

## Apply it to the capstone

Five build tasks and one test task this week; each one makes a concept from above visible in numbers you measure yourself. Keep the scripts in `scripts/week1/` so you can rerun them in later weeks.

For local targets, add a tiny endpoint to your app, `GET /slow`, that does `await asyncio.sleep(0.1)`. Then you measure the client side without depending on the internet.

### Task 1: 100 HTTP calls three ways (sections 1 to 3)

Goal: feel the difference between sequential, threads and asyncio for I/O.

- Write three functions over the same `URL` and `N = 100`: a loop with `httpx.Client`, `ThreadPoolExecutor(max_workers=20).map(...)` with the sync client, and `asyncio.gather` with one shared `httpx.AsyncClient`.
- Time each with `time.perf_counter()`. Reuse one client per approach; creating a client per call measures TLS handshakes, not concurrency.
- Predict before you run: with 100 ms per call, sequential is about 10 s; threads are bounded by `N / workers × 0.1 s`; asyncio is close to one round trip plus overhead.

My reference run against a local uvicorn: sequential 10.5 s, 20 threads 0.6 s, asyncio 0.35 s. Then try `max_workers=100` and explain why threads catch up.

### Task 2: 500 URLs, max 20 in flight, 2 s timeout each (sections 3 and 4)

Combine a `Semaphore(20)`, `asyncio.timeout(2.0)` per request, and a `TaskGroup`. Return a result object per URL instead of raising, so one bad URL does not cancel the other 499.

```python
@dataclass
class FetchResult:
    url: str
    status: int | None
    error: str | None
    seconds: float


async def fetch_one(client: httpx.AsyncClient, sem: asyncio.Semaphore, url: str) -> FetchResult:
    async with sem:
        start = time.perf_counter()
        try:
            async with asyncio.timeout(2.0):
                ...  # your request here
        except TimeoutError:
            ...  # build a FetchResult with error="timeout"
        except httpx.HTTPError as exc:
            ...
```

Hints:

- Put the timeout **inside** the semaphore. Otherwise time spent waiting for a slot counts against the 2 s.
- Set `httpx.Limits(max_connections=20)` too, so the connection pool agrees with your semaphore.
- Track peak in-flight with a counter to prove the limit holds.
- To test without a network, use `httpx.MockTransport` with an async handler that sleeps a random 0.05, 0.1 or 3 s. Every 3 s call must come back as a timeout at about 2.0 s.

### Task 3: make the app async (section 6)

Work in this order, keeping tests green after each step:

1. Add `asyncpg` and switch the URL to `postgresql+asyncpg://...`. In Docker Compose the host is the service name, for example `db`.
2. Replace the engine and session factory with `create_async_engine` and `async_sessionmaker(engine, expire_on_commit=False)`.
3. Turn `get_session` into an async yield dependency.
4. Convert the repository: every method `async def`, every DB call awaited (`await session.scalars(...)`, `await session.get(...)`, `await session.commit()`).
5. Change endpoints to `async def` and await the repository.
6. Add `lazy="raise"` to relationships and fix every failure with `selectinload` or `joinedload`.
7. Dispose the engine in lifespan.

```python
class EventRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list_upcoming(self, limit: int = 50) -> list[Event]:
        stmt = select(Event).where(Event.starts_at > func.now()).order_by(Event.starts_at).limit(limit)
        return list(await self._session.scalars(stmt))

    async def get(self, event_id: int) -> Event | None: ...
    async def reserve_seat(self, event_id: int) -> bool: ...  # see hint below
```

For no overselling, do not read `seats_left` in Python and then write it back: two concurrent requests can both see 1 seat. Make the database decide atomically, for example a single conditional `UPDATE ... SET seats_left = seats_left - 1 WHERE id = :id AND seats_left > 0` and check how many rows it changed. Async makes this race *more* likely, because requests interleave at every `await`.

### Task 4: block the loop on purpose, then fix it (section 5)

1. Add `GET /debug/block` as `async def` containing `time.sleep(1)`.
2. Run uvicorn with **one** worker. Fire 50 concurrent requests from a small `asyncio.gather` + `httpx.AsyncClient` script and record p50 and max latency.
3. Try three variants: `def` with `time.sleep(1)`, `async def` with `await asyncio.to_thread(time.sleep, 1)`, and `async def` with `await asyncio.sleep(1)`.
4. Run once with `PYTHONASYNCIODEBUG=1` and find the slow-callback warning in the logs.

My reference numbers for 50 requests on one worker:

| Variant | p50 latency | Max latency |
| --- | --- | --- |
| `async def` + `time.sleep(1)` | 25.6 s | 50.1 s |
| `def` + `time.sleep(1)` (thread pool) | 1.1 s | 2.1 s |
| `async def` + `await asyncio.sleep(1)` | 1.1 s | 1.1 s |

Explain each row in your notes. Why is the `def` variant 2.1 s at the max, not 1.1 s? (Hint: 40 threads.) Remove the debug endpoint afterwards, or guard it behind a setting.

### Task 5: in-process notification queue (section 7)

Prepare the shape of next month's Kafka worker without Kafka:

- Create an `asyncio.Queue[BookingCreated](maxsize=100)` and start N consumer tasks in lifespan, inside a TaskGroup or tracked in a set.
- After a successful booking commit, the endpoint does `queue.put_nowait(BookingCreated(...))`. Decide what happens on `QueueFull`: return 503, drop and log, or await `put`.
- On shutdown: `queue.shutdown()`, wait for consumers with a timeout, cancel the leftovers.
- Log each "notification" with the booking id. Later you replace `put_nowait` with a Kafka producer and the queue source with an aiokafka consumer; the consumer function barely changes.

Be honest in your notes about the limitation: an in-memory queue loses events on a crash. That is the problem Kafka (and later an outbox table) solves.

### Test: convert your first test to async (section 8)

- Add `pytest-asyncio` and `httpx` to dev dependencies; set `asyncio_mode = "auto"` and both default loop scopes to `"session"` in `pyproject.toml`.
- Write a `client` fixture that enters `lifespan(app)` and yields an `AsyncClient(transport=ASGITransport(app=app), base_url="http://test")`.
- Convert the first test to `async def` and `await client.get(...)`.
- Stretch: a test that fires 20 concurrent bookings against an event with capacity 5 and asserts exactly 5 succeed. It needs a real Postgres (the Compose service) to be meaningful.

## Check yourself

Answer out loud, as in an interview, before reading the answers.

1. Your service makes 3 DB queries and 2 HTTP calls per request. Would moving it from threads to asyncio make one request faster? What does it change?
2. What exactly happens between `await conn.fetchrow(...)` suspending and resuming? Name the OS mechanism involved.
3. What is the difference between a coroutine, a Future and a Task? Why does `await a(); await b()` not run concurrently?
4. `gather(a(), b(), c())` and `b()` raises. What happens to `a()` and `c()`? How does `TaskGroup` differ?
5. Why must you re-raise `CancelledError`? Give a concrete bug that swallowing it causes.
6. A FastAPI endpoint is `async def` and uses `requests.get`. Describe the symptom under load and two fixes.
7. Why does FastAPI run `def` endpoints in a thread pool, and what limits how many run at once?
8. Why is `expire_on_commit=False` recommended for `AsyncSession`, and what error do you get from lazy loading in async SQLAlchemy?
9. How would you limit an async crawler to 20 concurrent requests with a 2-second timeout per request, without one failure stopping the rest?
10. How do you shut down a queue-based async worker gracefully on SIGTERM?
11. In pytest-asyncio, why might a session-scoped async DB engine fixture fail with "attached to a different loop", and how do you fix it?
12. Does the free-threaded CPython build make asyncio obsolete? Why or why not?

## Answers

1. No, a single request is not faster unless you overlap its own calls with a TaskGroup. Asyncio changes throughput and memory: one thread can hold thousands of waiting requests, versus one OS thread per in-flight request.
2. The driver sends the query, creates a Future and registers the socket with the loop. The `yield` travels up to the Task, which returns to the loop. The loop runs other work, then blocks in the selector (`epoll` on Linux). When the socket becomes readable, a callback sets the Future's result, which schedules the Task to `send()` the value back into the coroutine.
3. A coroutine is a paused function; a Future is a result slot; a Task is a Future that drives a coroutine and is scheduled on the loop. Awaiting a coroutine runs it inline in the current task, so `b()` starts only after `a()` finishes. Concurrency needs separate Tasks.
4. The exception propagates to the caller, but `a()` and `c()` keep running unsupervised. A TaskGroup cancels the siblings, waits for them, and raises an `ExceptionGroup`.
5. Timeouts, TaskGroups and shutdown all work by cancelling. If you swallow it, `asyncio.timeout` never raises (the task keeps running past its deadline), a TaskGroup waits on a child that refuses to stop, and a worker hangs on SIGTERM until killed.
6. Every request on that worker queues behind the blocking call, so latency grows linearly with concurrency and health checks time out. Fix by switching to `httpx.AsyncClient`, wrapping the call in `asyncio.to_thread`, or declaring the endpoint as plain `def`.
7. Calling a sync function directly on the loop would block it, so Starlette hands it to `anyio.to_thread.run_sync`. AnyIO's default capacity limiter allows 40 threads; extra requests wait for a free slot.
8. Commit expires loaded attributes, and refreshing them would need implicit I/O during attribute access, which async cannot do. Lazy-loading a relationship raises `MissingGreenlet`. Fix with eager loading (`selectinload`), `awaitable_attrs`, or `lazy="raise"` to catch it early.
9. One shared `Semaphore(20)` and one `AsyncClient`, a task per URL in a TaskGroup, and inside each task `async with sem:` then `async with asyncio.timeout(2):`. Catch `TimeoutError` and HTTP errors inside the task and return a result object, so the group never sees an exception.
10. A signal handler sets an `asyncio.Event`; the producer stops taking input; `queue.shutdown()` (or one sentinel per consumer) lets consumers drain and exit; wait for them under a timeout shorter than the container grace period; then close resources in `finally` or `async with`.
11. The fixture was created on one loop and the test runs on another, because loop scope defaults to function. Align them: give the fixture and tests the same `loop_scope` (for example, `"session"` via the default loop scope settings).
12. No. Free-threading gives threads true CPU parallelism, which helps CPU-bound work. Asyncio solves a different problem: many concurrent waits at low memory cost with no pre-emptive races. The build is also optional and not the default as of 3.14.

## Sources

All pages opened while writing these notes. Code snippets were run locally on Python 3.13, FastAPI 0.161, SQLAlchemy 2.1, httpx 0.28, pytest 9.1 and pytest-asyncio 1.4.

- [Python HOWTO: Free-threaded CPython](https://docs.python.org/3/howto/free-threading-python.html)
- [PEP 779: Criteria for supported status for free-threaded Python](https://peps.python.org/pep-0779/)
- [asyncio: Coroutines and Tasks](https://docs.python.org/3/library/asyncio-task.html) (TaskGroup, timeout, gather, as\_completed, shield, cancellation)
- [asyncio: Event Loop](https://docs.python.org/3/library/asyncio-eventloop.html) (run\_in\_executor, slow\_callback\_duration)
- [asyncio: Developing with asyncio](https://docs.python.org/3/library/asyncio-dev.html) (debug mode)
- [asyncio: Queues](https://docs.python.org/3/library/asyncio-queue.html) (shutdown, task\_done, join)
- [concurrent.futures](https://docs.python.org/3/library/concurrent.futures.html) (pool sizes, InterpreterPoolExecutor)
- [AnyIO: Working with threads](https://anyio.readthedocs.io/en/stable/threads.html) (default limit of 40)
- [FastAPI: Concurrency and async / await](https://fastapi.tiangolo.com/async/)
- [FastAPI: Dependencies with yield](https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-with-yield/)
- [FastAPI: Lifespan Events](https://fastapi.tiangolo.com/advanced/events/)
- [SQLAlchemy: Asynchronous I/O (asyncio)](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html)
- [pytest-asyncio: Configuration](https://pytest-asyncio.readthedocs.io/en/stable/reference/configuration.html)
- [pytest-asyncio: Changelog](https://pytest-asyncio.readthedocs.io/en/stable/reference/changelog.html)
- [HTTPX: Transports (ASGITransport)](https://www.python-httpx.org/advanced/transports/)
- [Python downloads](https://www.python.org/downloads/) (current releases: 3.14.9 and 3.15.1 as of Oct 2026)
