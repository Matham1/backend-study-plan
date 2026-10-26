# Study Notes — Week 3: Transactions and Concurrency in PostgreSQL

Oct 23, 2026 · @Mathew Matholomew

After these notes you will know what a PostgreSQL transaction actually guarantees, how MVCC snapshots decide what each statement sees, and which anomalies each isolation level allows in Postgres specifically. You will be able to pick and implement a no-overselling strategy for the event-booking API in SQLAlchemy 2.0 async, map database errors to 409s and retries, and prove it works with a 50-requests-for-10-seats concurrency test against a real Postgres.

## 1. Transactions and ACID in Postgres

A transaction is a group of statements that either all take effect or none do, and that other sessions see as one step. ACID names four promises. Each maps to a concrete Postgres mechanism, and knowing the mechanism tells you where the promise ends.

**Atomicity: the commit record.** Postgres never edits a row in place. An UPDATE writes a new row version and marks the old one as replaced by transaction X. Whether X's changes "exist" depends on one bit: is X marked committed in the commit log (`pg_xact`)? COMMIT flips that status. ROLLBACK just marks X aborted. Its row versions stay on disk but are invisible to everyone and later cleaned up. That is why rollback is cheap in Postgres: nothing is undone, the work is simply never made visible.

**Durability: the write-ahead log (WAL).** Before a changed data page may reach disk, the WAL record describing the change must be flushed first. At COMMIT, Postgres only has to fsync the WAL, which is a sequential append. Data pages are written later by the checkpointer. After a crash, recovery replays WAL from the last checkpoint. So "committed" means "the WAL record is on stable storage". Setting `synchronous_commit = off` weakens this: COMMIT returns before the flush, so a crash can lose the last fraction of a second of commits (but never corrupts data).

**Consistency: constraints you declare.** The database can only keep rules it knows about. `CHECK (seats_left >= 0)`, `UNIQUE (user_id, event_id)`, foreign keys and NOT NULL are checked on every write, inside the transaction, regardless of how many app servers or bugs you have. Business rules that live only in Python are not covered by the C in ACID.

**Isolation: the hard one.** It is not a single guarantee but a level you choose. Sections 2 to 4 cover it.

### Autocommit vs explicit transactions

Postgres has no "statement outside a transaction". If you send a statement without BEGIN, the server wraps it in its own implicit transaction and commits it immediately. That is autocommit.

```sql
-- Autocommit: two independent transactions. A crash or error between them
-- leaves a decremented counter with no booking row.
UPDATE events SET seats_left = seats_left - 1 WHERE id = 42;
INSERT INTO bookings (user_id, event_id) VALUES (7, 42);

-- Explicit: both or neither.
BEGIN;
UPDATE events SET seats_left = seats_left - 1 WHERE id = 42;
INSERT INTO bookings (user_id, event_id) VALUES (7, 42);
COMMIT;
```

Python drivers flip this default. The DB-API (psycopg, and SQLAlchemy on top of asyncpg) opens a transaction implicitly on the first statement and keeps it open until you commit. In SQLAlchemy 2.0 the session "autobegins" the same way. So in Python the risk is the opposite: a transaction that stays open longer than you think, holding locks and an old snapshot.

One more Postgres rule: after any error inside a transaction, the transaction is poisoned. Every later statement fails with SQLSTATE `25P02` ("current transaction is aborted") until you ROLLBACK. You cannot catch a unique violation and keep going in the same transaction, unless you used a savepoint.

### Savepoints

A savepoint is a named marker inside a transaction. ROLLBACK TO SAVEPOINT undoes only the work after the marker and clears the error state. The outer transaction continues.

```sql
BEGIN;
INSERT INTO bookings (user_id, event_id) VALUES (7, 42);
SAVEPOINT try_waitlist;
INSERT INTO waitlist (user_id, event_id) VALUES (7, 42);  -- fails: duplicate
ROLLBACK TO SAVEPOINT try_waitlist;                      -- error cleared
COMMIT;                                                  -- booking is kept
```

In SQLAlchemy, `session.begin_nested()` emits SAVEPOINT. Used as an async context manager, it rolls back to the savepoint on exception and leaves the outer transaction alive.

```python
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession


async def add_to_waitlist_if_new(session: AsyncSession, user_id: int, event_id: int) -> bool:
    """Inside an already-open transaction. Returns False on duplicate."""
    try:
        async with session.begin_nested():
            session.add(Waitlist(user_id=user_id, event_id=event_id))
        return True
    except IntegrityError:
        return False  # outer transaction is still usable
```

**Pitfalls**

- Treating two autocommitted statements as "one operation". If they must agree, wrap them in one transaction.
- Catching an error inside a transaction and continuing without a savepoint. Postgres rejects everything until ROLLBACK (`25P02`).
- Savepoints are not free. Each one is a subtransaction. Hundreds per transaction (for example, one per row in a loop) cost memory and can slow down other sessions.
- Relying on Python checks for invariants. If a rule matters, encode it as a constraint so it holds across all writers.

## 2. MVCC: how Postgres lets readers and writers coexist

Postgres keeps several versions of a row at once and lets each transaction pick the version it is allowed to see. This is multiversion concurrency control (MVCC). The payoff: a plain SELECT never waits for a writer, and a writer never waits for a plain SELECT.

### Tuple versions and xmin/xmax

Every physical row version (a "tuple") carries hidden header fields. The two that matter here:

- `xmin`: the id of the transaction that created this version.
- `xmax`: the id of the transaction that deleted or replaced it (0 if still live).

INSERT writes a tuple with `xmin = me`. DELETE does not remove anything; it sets `xmax = me` on the existing tuple. UPDATE is DELETE plus INSERT: it stamps `xmax = me` on the old tuple, writes a new tuple with `xmin = me`, and links the old one to the new one through `ctid`.

You can see this yourself. I ran this on PostgreSQL 16 with a one-row `events` table:

```sql
SELECT xmin, xmax, ctid, seats_left FROM events;
--  xmin | xmax | ctid  | seats_left
--   733 |    0 | (0,1) |         10

UPDATE events SET seats_left = seats_left - 1 WHERE id = 1;  -- runs as txid 734

-- Inspect the raw heap page (needs: CREATE EXTENSION pageinspect)
SELECT lp, t_xmin, t_xmax, t_ctid FROM heap_page_items(get_raw_page('events', 0));
--  lp | t_xmin | t_xmax | t_ctid
--   1 |    733 |    734 | (0,2)   <- old version, replaced by 734
--   2 |    734 |      0 | (0,2)   <- new version, live
```

Two physical tuples now exist for one logical row. Which one you see depends on your snapshot.

### Snapshots and visibility

A snapshot is a cheap record of "which transactions had committed at a given moment". It holds the lowest still-running transaction id, the next id to be assigned, and the list of ids in progress. You can print the current one with `SELECT pg_current_snapshot();`.

The visibility rule, simplified: a tuple is visible to me if its `xmin` committed before my snapshot was taken, and its `xmax` is empty, aborted, or committed after my snapshot. Commit status is looked up in the commit log (`pg_xact`), then cached as hint bits on the tuple.

When the snapshot is taken depends on the isolation level:

- **Read Committed**: a fresh snapshot at the start of each statement.
- **Repeatable Read and Serializable**: one snapshot at the first statement of the transaction, reused until the end.

That single difference explains most of section 4.

### Why readers don't block writers

A reader never needs a lock on the row. It just walks the versions and picks the visible one. A writer creating a new version does not disturb the old version a reader is looking at. Writers do block other writers of the same row: the second writer must wait to learn whether the first committed (section 4 shows what happens next).

The catch: "reads don't block" also means "reads don't protect". A SELECT that saw `seats_left = 1` reserved nothing. Another transaction can take that seat a microsecond later. This is the root of every booking bug in section 3.

### What VACUUM cleans up

Old versions pile up. Once no running transaction's snapshot can still see a tuple, it is dead. VACUUM (normally autovacuum, in the background) does four things:

1. Marks the space of dead tuples (and their index entries) as reusable. It rarely shrinks the file.
2. Updates the visibility map, which makes index-only scans cheaper.
3. Freezes very old tuples so 32-bit transaction ids can wrap around safely.
4. With ANALYZE, refreshes planner statistics.

Plain VACUUM runs alongside normal reads and writes. `VACUUM FULL` rewrites the table under an exclusive lock and blocks everything, so avoid it on a live system.

The operational lesson: **a long-running transaction stops VACUUM from removing anything newer than its snapshot.** A forgotten `idle in transaction` session can bloat a hot table like `events` within hours. Watch `pg_stat_activity` for old `xact_start` values.

**Pitfalls**

- Assuming a SELECT "holds" the value it read. It does not. Only locks or constraints hold anything.
- Hot counters (`seats_left` updated thousands of times) produce many dead tuples. That is normal; autovacuum handles it unless a long transaction blocks it.
- Leaving a session `idle in transaction` (for example, an endpoint that awaits an HTTP call while a DB transaction is open). It blocks cleanup and may hold locks. Set `idle_in_transaction_session_timeout` for the app role.
- Reaching for `VACUUM FULL` to fix bloat in production. It takes an ACCESS EXCLUSIVE lock.

## 3. Anomalies, told as booking bugs

An anomaly is a result that could not happen if the transactions had run one after another. Each one below is a real way the booking API can go wrong. Read the timelines top to bottom; T1 and T2 are two concurrent requests, each in its own connection.

Schema used throughout:

```sql
CREATE TABLE events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title       text NOT NULL,
    seats_left  int  NOT NULL CHECK (seats_left >= 0),
    version     int  NOT NULL DEFAULT 0
);

CREATE TABLE bookings (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint NOT NULL,
    event_id   bigint NOT NULL REFERENCES events(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_bookings_user_event UNIQUE (user_id, event_id)
);
```

### Dirty read

Reading data another transaction has written but not committed. If T2 shows "0 seats left" because T1 decremented and then rolled back, a user is turned away from a seat that exists.

| Step | T1 | T2 |
| --- | --- | --- |
| 1 | `UPDATE events SET seats_left = 0 WHERE id = 42` |  |
| 2 |  | `SELECT seats_left ...` would see 0 |
| 3 | `ROLLBACK` | shown "sold out" for a seat that exists |

Postgres never allows this, at any level. A tuple whose `xmin` has not committed is invisible to everyone else.

### Non-repeatable read

The same row, read twice in one transaction, returns different values because someone committed in between. The booking page handler reads the event for the header, then again for the price summary, and the numbers disagree.

| Step | T1 (render event page) | T2 (booking) |
| --- | --- | --- |
| 1 | `SELECT seats_left FROM events WHERE id = 42` → 5 |  |
| 2 |  | `UPDATE ... seats_left = 4`; `COMMIT` |
| 3 | `SELECT seats_left FROM events WHERE id = 42` → 4 |  |

Possible in Read Committed, because step 3 takes a new snapshot.

### Phantom read

A query with a condition returns a different set of rows the second time, because another transaction inserted or deleted matching rows. T1 counts the bookings for event 42 for a report, then lists them, and the list has one more row than the count.

| Step | T1 (report) | T2 (booking) |
| --- | --- | --- |
| 1 | `SELECT count(*) FROM bookings WHERE event_id = 42` → 9 |  |
| 2 |  | `INSERT INTO bookings ... (event 42)`; `COMMIT` |
| 3 | `SELECT * FROM bookings WHERE event_id = 42` → 10 rows |  |

Possible in Read Committed. Repeatable Read in Postgres prevents it, because the whole transaction uses one snapshot.

### Lost update

The classic overselling bug. Both transactions read the counter, compute a new value in application code, and write it back. The second write overwrites the first, so one decrement disappears.

| Step | T1 | T2 |
| --- | --- | --- |
| 1 | `SELECT seats_left` → 10 |  |
| 2 |  | `SELECT seats_left` → 10 |
| 3 | `UPDATE ... SET seats_left = 9` (Python computed 10 - 1) |  |
| 4 |  | `UPDATE ... SET seats_left = 9` waits for T1's row lock |
| 5 | `INSERT booking`; `COMMIT` |  |
| 6 |  | lock granted, writes 9; `INSERT booking`; `COMMIT` |

Result: two bookings, `seats_left = 9`. I ran exactly this in Read Committed against PostgreSQL 16: the final value was 9, not 8. A looser version (50 concurrent requests, ORM read, Python `ev.seats_left -= 1`) produced 50 bookings for a 10-seat event with `seats_left` still at 9.

Note what did not help: T2 did wait at step 4. Row locks serialise the writes, but T2 writes a value it computed from a stale read. The fix is to make the read and the write one step (an atomic UPDATE), or to lock at read time, or to raise the isolation level so Postgres detects the conflict.

&#91;embedded content: lost update vs conditional UPDATE · two transactions, one seat\]

On the left, T2 waits for T1's lock but then writes a value it computed before T1 committed. On the right, the wait ends with a re-check of the condition, so T2 correctly finds no seat.

### Write skew

The subtle one. Two transactions read an overlapping set of rows, each makes a decision based on what it read, and each writes a different row. No row is written twice, so no row lock conflicts. Yet the combined result breaks a rule that each transaction checked.

Booking example: a festival rule says "a user may hold at most one booking across all days of the festival". Days are separate events, so `UNIQUE (user_id, event_id)` does not cover it.

| Step | T1 (user 7 books Day 1) | T2 (user 7 books Day 2) |
| --- | --- | --- |
| 1 | `SELECT count(*) FROM bookings WHERE user_id = 7 AND festival_id = 3` → 0 |  |
| 2 |  | same query → 0 |
| 3 | `INSERT booking (7, day1)` |  |
| 4 |  | `INSERT booking (7, day2)` |
| 5 | `COMMIT` | `COMMIT` |

Result: two bookings, rule broken. Both inserts touch different rows, so nothing blocked. I reproduced this in Repeatable Read (both committed) and in Serializable (the second commit failed with SQLSTATE `40001`).

The "both see 1 seat left" variant is write skew too if the seat count is derived rather than stored: each transaction runs `SELECT count(*) FROM bookings WHERE event_id = 42`, sees 9 of 10 taken, and inserts. Both inserts succeed and the event holds 11 bookings. Storing `seats_left` on the event row turns this into a same-row conflict, which is much easier to guard.

**Pitfalls**

- Thinking "I'm in a transaction, so I'm safe". The default level allows lost updates and write skew.
- Checking a rule with SELECT, then writing. That check is only valid if nothing changed in between, and in Read Committed nothing guarantees that.
- Testing with one request at a time. These bugs appear only under real concurrency (section 9).

## 4. Isolation levels as Postgres actually implements them

The SQL standard defines four levels by which anomalies they forbid. Postgres accepts all four names but implements three behaviours, and it is stricter than the standard requires in two places. Learn the Postgres behaviour, not the textbook table.

```sql
SHOW default_transaction_isolation;                -- read committed
BEGIN ISOLATION LEVEL REPEATABLE READ;             -- per transaction
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;      -- first statement after BEGIN
ALTER ROLE booking_app SET default_transaction_isolation = 'repeatable read';
```

### Read Uncommitted

Accepted as a name, behaves exactly like Read Committed. MVCC has no way to show you uncommitted tuples, so you never get dirty reads.

### Read Committed (the default)

Each **statement** gets a fresh snapshot. Within one statement, you see a consistent picture of everything committed before that statement started.

The interesting part is what UPDATE, DELETE and SELECT FOR UPDATE do when the target row was changed by a concurrent transaction:

1. The statement finds the row through its snapshot.
2. It sees the row is locked or already replaced by an in-progress transaction, so it waits.
3. If that transaction rolls back, it carries on with the row it found.
4. If it commits a delete, the row is skipped.
5. If it commits an update, Postgres follows the `ctid` chain to the newest version and **re-evaluates the WHERE clause on that version**. If it still matches, the update applies to the newest version. If not, the row is skipped.

Step 5 is why `UPDATE events SET seats_left = seats_left - 1 WHERE id = 42 AND seats_left > 0` is safe in Read Committed. The second transaction waits, then re-checks `seats_left > 0` against the committed value, and computes `seats_left - 1` from that value too. I tested it: with one seat left, T1 got `seats_left = 0` back, T2 updated zero rows.

The trade-off: one statement can combine data from two moments (rows found through the old snapshot, values from the newest version). For single-row conditional updates that is exactly what you want. For complex multi-table conditions it can surprise you.

### Repeatable Read (snapshot isolation)

One snapshot for the whole transaction, taken at the first real statement (not at BEGIN). Every query sees the same data, so no non-repeatable reads and, in Postgres, no phantoms either.

On a write conflict, Postgres does not re-check and continue. It waits for the other writer, and if that writer committed, it raises:

```text
ERROR:  could not serialize access due to concurrent update
SQLSTATE: 40001
```

That turns the lost update into an error. In my test, T2's UPDATE failed with `40001` and the app must retry the whole transaction (re-read, re-decide, re-write). Write skew still slips through, because the two transactions write different rows and never conflict.

Read-only transactions at this level never fail this way. That makes Repeatable Read a good choice for reports that run several queries and need them to agree.

### Serializable (SSI)

Serializable Snapshot Isolation is Repeatable Read plus tracking of read/write dependencies. Each Serializable transaction records what it read as SIRead "predicate locks". These never block anybody. When Postgres sees a dangerous pattern (T1 read something T2 wrote, and T2 read something T1 wrote, in a way no serial order can explain), it aborts one of them with:

```text
ERROR:  could not serialize access due to read/write dependencies among transactions
SQLSTATE: 40001
```

The guarantee: if every transaction runs at Serializable and the app retries on `40001`, the database behaves as if transactions ran one at a time. Write skew is caught. The festival example from section 3 failed the second commit.

The costs:

- **Retries are mandatory**, and can be frequent under contention. In my 50-requests-for-10-seats test, Serializable needed 191 attempts in total to finish 50 requests.
- False positives happen. Postgres may abort transactions that were actually fine, especially when predicate locks are coarsened from rows to pages or whole tables (for example after a sequential scan).
- Reads are not trustworthy until commit. Do not send a Kafka message or an email based on data read inside a Serializable transaction that has not committed yet.
- It only protects transactions that run at Serializable. A Read Committed writer can still break invariants.

Tips that help: declare reporting transactions `READ ONLY`; keep transactions short; make sure your queries use indexes (fewer, finer predicate locks).

### Anomalies by level, in PostgreSQL

| Level | Dirty read | Non-repeatable read | Phantom | Lost update | Write skew | On conflict |
| --- | --- | --- | --- | --- | --- | --- |
| Read Uncommitted | No | Yes | Yes | Yes | Yes | same as Read Committed |
| Read Committed | No | Yes | Yes | Yes (read-modify-write in app) | Yes | waits, re-checks WHERE on newest row |
| Repeatable Read | No | No | No (stricter than the standard) | No: `40001` | Yes | waits, then `40001` if other committed |
| Serializable | No | No | No | No: `40001` | No: `40001` | `40001` at statement or commit |

Lost update in Read Committed is possible only for the read-in-app, write-later pattern. An atomic `SET x = x - 1` is never lost, thanks to the re-check.

**Pitfalls**

- Setting the isolation level after the transaction has started. `SET TRANSACTION` must be the first statement; SQLAlchemy must set it before the first query (section 8).
- Choosing Repeatable Read or Serializable without a retry loop. Without retries, you have just converted race conditions into 500 errors.
- Assuming Serializable is free because it does not block. The cost is aborted work and retries.
- Forgetting that Repeatable Read still allows write skew. Use constraints or explicit locks for those rules, or go Serializable.

## 5. Preventing overselling: six tools and when to use each

The invariant: bookings for an event never exceed its capacity, and a user books an event at most once. There are several correct ways to keep it. They differ in how much they block, how much they retry, and how much logic they let you run between the check and the write.

The examples below assume SQLAlchemy 2.0 ORM models `Event` and `Booking` matching the schema in section 3, plus two domain exceptions:

```python
class SoldOut(Exception): ...
class AlreadyBooked(Exception): ...
```

### (a) Atomic conditional UPDATE

Put the check and the decrement in one statement. Postgres row locking plus the Read Committed re-check (section 4) does the rest.

```sql
UPDATE events
   SET seats_left = seats_left - 1
 WHERE id = :event_id AND seats_left > 0
RETURNING seats_left;
-- 1 row back: you got a seat. 0 rows: sold out (or no such event).
```

```python
from sqlalchemy import insert, update
from sqlalchemy.ext.asyncio import AsyncSession


async def reserve_seat(session: AsyncSession, event_id: int, user_id: int) -> int:
    """Call inside `async with session.begin()`. Returns the new booking id."""
    stmt = (
        update(Event)
        .where(Event.id == event_id, Event.seats_left > 0)
        .values(seats_left=Event.seats_left - 1)
        .returning(Event.seats_left)
    )
    if (await session.execute(stmt)).scalar_one_or_none() is None:
        raise SoldOut(event_id)
    result = await session.execute(
        insert(Booking).values(user_id=user_id, event_id=event_id).returning(Booking.id)
    )
    return result.scalar_one()
```

Concurrent requests for the same event queue on the row lock for the few microseconds between UPDATE and COMMIT. No retries are needed. If the INSERT then fails (duplicate booking), the whole transaction rolls back, including the decrement. Distinguishing "sold out" from "event does not exist" needs one extra cheap SELECT, only on the zero-rows path.

### (b) Pessimistic lock: SELECT ... FOR UPDATE

Lock the event row first, then run any checks you like in Python, then write. Anyone else who wants that row for writing or locking waits until you commit.

```python
from sqlalchemy import select


async def reserve_seat_locked(session: AsyncSession, event_id: int, user_id: int) -> Booking:
    event = (
        await session.execute(select(Event).where(Event.id == event_id).with_for_update())
    ).scalar_one()
    if event.seats_left <= 0:
        raise SoldOut(event_id)
    if event.sales_closed_at is not None:      # any extra rule, checked under the lock
        raise SalesClosed(event_id)
    event.seats_left -= 1                      # safe now: nobody else can change it
    booking = Booking(user_id=user_id, event_id=event_id)
    session.add(booking)
    await session.flush()                      # surfaces IntegrityError here, gets booking.id
    return booking
```

This is the right tool when the decision needs more than one condition in a WHERE clause: tiered pricing, per-user quotas, sales windows. The cost is that the lock is held for the rest of the transaction. Never await anything slow (HTTP calls, Kafka produce) while holding it.

### (c) Optimistic concurrency: a version column

Read without locking, then write only if nobody changed the row since you read it. Detect the conflict by the row count.

```python
async def reserve_seat_optimistic(session: AsyncSession, event_id: int, user_id: int) -> None:
    event = (await session.execute(select(Event).where(Event.id == event_id))).scalar_one()
    if event.seats_left <= 0:
        raise SoldOut(event_id)
    result = await session.execute(
        update(Event)
        .where(Event.id == event_id, Event.version == event.version)
        .values(seats_left=event.seats_left - 1, version=event.version + 1)
    )
    if result.rowcount == 0:
        raise StaleData(event_id)   # someone else won; caller retries the whole function
    session.add(Booking(user_id=user_id, event_id=event_id))
```

SQLAlchemy can do the version check for you with `__mapper_args__ = {"version_id_col": version}`; it raises `StaleDataError` on mismatch. Optimistic locking shines when conflicts are rare and the read-then-write span is long, for example an admin editing event details in a form for two minutes. For a hot counter like seats on a popular event, almost every request conflicts, and you burn CPU on retries.

### (d) SERIALIZABLE plus a retry loop

Write the naive read-check-write code, run it at Serializable, and retry on `40001`. Postgres guarantees the result is equivalent to some serial order.

```python
@retry_on_serialization_failure(attempts=10)        # defined in section 8
async def reserve_seat_serializable(sm: async_sessionmaker[AsyncSession], event_id: int, user_id: int) -> None:
    async with sm() as session, session.begin():
        await session.connection(execution_options={"isolation_level": "SERIALIZABLE"})
        event = (await session.execute(select(Event).where(Event.id == event_id))).scalar_one()
        if event.seats_left <= 0:
            raise SoldOut(event_id)
        event.seats_left -= 1
        session.add(Booking(user_id=user_id, event_id=event_id))
```

Note the retry wraps the session creation and the whole transaction, not one statement. It is the only option here that also catches write skew across rows you did not think to lock (the festival rule). The price is aborted work under contention: 191 attempts for 50 requests in my test.

### (e) Constraints: the last line of defence

Constraints do not replace (a) to (d), but they make sure a bug in that code cannot corrupt data.

```sql
ALTER TABLE events   ADD CONSTRAINT ck_events_seats_left_nonneg CHECK (seats_left >= 0);
ALTER TABLE bookings ADD CONSTRAINT uq_bookings_user_event UNIQUE (user_id, event_id);
```

- `CHECK (seats_left >= 0)` turns an oversell into an error (SQLSTATE `23514`) rather than a negative counter.
- `UNIQUE (user_id, event_id)` is the only reliable way to stop double booking. Two requests from the same user (double click, client retry) both pass a "does a booking exist?" SELECT, then both insert. The unique index serialises them: the second INSERT waits for the first transaction, then fails with `23505` if it committed.

Map the errors at the edge of the service, not deep in the code:

```python
from sqlalchemy.exc import IntegrityError


def constraint_name(exc: IntegrityError) -> str | None:
    # asyncpg exposes it on the original exception; SQLAlchemy wraps that as exc.orig.__cause__
    cause = exc.orig.__cause__ if exc.orig is not None else None
    return getattr(cause, "constraint_name", None)

# in the service:
try:
    async with session.begin():
        booking_id = await reserve_seat(session, event_id, user_id)
except IntegrityError as exc:
    if constraint_name(exc) == "uq_bookings_user_event":
        raise AlreadyBooked(event_id) from exc
    raise
```

Name your constraints explicitly so this mapping survives migrations.

### (f) Advisory locks

An advisory lock is a lock on a number you choose, not on a row. Postgres does not know what it protects; your code has to agree to use it. The transaction-scoped form releases itself at COMMIT or ROLLBACK.

```sql
-- Serialise all checkout logic for one user, across events, for this transaction only
SELECT pg_advisory_xact_lock(hashtextextended('user-checkout:' || :user_id, 0));
```

Use it when the thing to protect is not a single row: the festival rule ("one booking per user per festival") with no row to lock, or a job that must run on one worker at a time. Prefer `pg_advisory_xact_lock` over the session-level `pg_advisory_lock`, which survives rollback and leaks easily with connection pools.

### Comparison

| Strategy | Blocks? | Retries? | Prevents | Best for | Main risk |
| --- | --- | --- | --- | --- | --- |
| (a) Conditional UPDATE | Briefly, on the row | No | Oversell on one counter | Hot counters, simple rule | Rule must fit in a WHERE clause |
| (b) SELECT FOR UPDATE | Yes, until commit | No (deadlock retry only) | Any rule on the locked row | Multi-condition checks | Long transactions, deadlocks |
| (c) Version column | No | Yes, on conflict | Lost update | Rare conflicts, long edits | Retry storms on hot rows |
| (d) Serializable + retry | No (SIRead) | Yes, `40001` | All anomalies incl. write skew | Cross-row invariants | Abort rate, false positives |
| (e) Constraints | On unique key only | No | Invariant breach, duplicates | Always, as a backstop | Only rules a constraint can express |
| (f) Advisory lock | Yes, on the key | No | Whatever your code agrees on | Rules with no row to lock | Forgotten by one code path |

### Recommendation for the capstone

Use **(a) conditional UPDATE + (e) constraints**, in one Read Committed transaction:

1. `UPDATE ... WHERE seats_left > 0 RETURNING` to claim a seat.
2. `INSERT` the booking.
3. COMMIT. Map `0 rows` to 409 sold out and `uq_bookings_user_event` violations to 409 already booked.

Why: it is the shortest possible critical section, needs no retry loop, works at the default isolation level, and the database proves the invariant rather than your Python code. It also keeps the hot row lock short, which matters when 5,000 people hit "Book" at 10:00. Switch to (b) the day the rule grows beyond one WHERE condition. Keep (d) and (f) in your pocket for cross-row rules.

**Pitfalls**

- Using `ORM read + ev.seats_left -= 1` without a lock. That is the lost-update pattern; it oversold 50 bookings for 10 seats in my test.
- Forgetting that a failed INSERT after a successful UPDATE must roll back the UPDATE. It will, as long as both run in the same transaction.
- Retrying only the failed statement in (c) or (d). Retry the whole unit, including the reads.
- Matching on error message strings. Match on SQLSTATE and constraint name.

## 6. Row lock modes, NOWAIT, SKIP LOCKED and timeouts

Row locks are stored in the tuple header itself (via `xmax` and flag bits), not in a lock table, so locking a million rows costs disk writes but not memory. Plain SELECTs ignore them. They only affect other writers and lockers.

### The four modes

From strongest to weakest:

| Mode | Taken by | Blocks |
| --- | --- | --- |
| `FOR UPDATE` | `SELECT ... FOR UPDATE`, DELETE, UPDATE that changes a key column | All other row locks |
| `FOR NO KEY UPDATE` | Any other UPDATE (e.g. `seats_left = seats_left - 1`) | Everything except `FOR KEY SHARE` |
| `FOR SHARE` | `SELECT ... FOR SHARE` | Writers and exclusive lockers; not other sharers |
| `FOR KEY SHARE` | Foreign key checks on INSERT into a child table | Only `FOR UPDATE` (deletes, key changes) |

Why this matters for bookings: inserting a booking runs a foreign key check that takes `FOR KEY SHARE` on the parent `events` row. Your conditional UPDATE takes `FOR NO KEY UPDATE`. These two do not conflict, so bookings for an event can be inserted while another transaction holds the seat counter. If you lock with `SELECT ... FOR UPDATE` instead, those FK checks will wait. When you only intend to change non-key columns, `FOR NO KEY UPDATE` is the friendlier lock.

In SQLAlchemy the mapping is a little indirect. I compiled each variant for the PostgreSQL dialect:

| `with_for_update(...)` | Renders |
| --- | --- |
| `()` | `FOR UPDATE` |
| `(key_share=True)` | `FOR NO KEY UPDATE` |
| `(read=True)` | `FOR SHARE` |
| `(read=True, key_share=True)` | `FOR KEY SHARE` |
| `(nowait=True)` | `FOR UPDATE NOWAIT` |
| `(skip_locked=True)` | `FOR UPDATE SKIP LOCKED` |
| `(of=Event)` | `FOR UPDATE OF events` (lock only that table in a join) |

`FOR SHARE` fits "make sure this row does not change while I read related data", for example confirming an event is not cancelled while inserting a booking, without blocking other bookers who also take `FOR SHARE`.

Locking clauses cannot be combined with aggregates, GROUP BY or DISTINCT, because the result rows do not map to table rows.

### NOWAIT: fail instead of waiting

```sql
SELECT id FROM events WHERE id = 42 FOR UPDATE NOWAIT;
-- if another transaction holds it:
-- ERROR: could not obtain lock on row in relation "events"   SQLSTATE 55P03
```

Useful when waiting is worse than failing: an admin "edit event" screen that should say "someone else is editing" right away.

### SKIP LOCKED: the queue pattern

Rows that are locked are silently left out of the result. That gives an inconsistent view, so it is wrong for business reads ("how many seats left") but exactly right for work queues, where several workers each want *some* unclaimed row.

The capstone has one natural queue: a transactional outbox. Instead of producing to Kafka inside the request (which can fail after the DB commit, or succeed before a rollback), you insert an `outbox` row in the same transaction as the booking. A relay worker then publishes them:

```sql
WITH batch AS (
    SELECT id FROM outbox
     WHERE published_at IS NULL
     ORDER BY id
     LIMIT 100
       FOR UPDATE SKIP LOCKED
)
UPDATE outbox o SET published_at = now()
  FROM batch WHERE o.id = batch.id
RETURNING o.id, o.topic, o.payload;
-- publish the returned rows to Kafka, then COMMIT
```

Two relay processes running this at once get disjoint batches, with no waiting and no double claims. If a worker crashes before COMMIT, its rows unlock and are picked up again (so consumers must tolerate duplicates).

### lock\_timeout and statement\_timeout

- `lock_timeout`: maximum time to wait for any single lock (row, table, index). Fires only while waiting. Error `55P03`.
- `statement_timeout`: maximum run time for any single statement, waiting or working. Error `57014` (query canceled).
- `idle_in_transaction_session_timeout`: kills a session that sits inside an open transaction doing nothing.
- `transaction_timeout` (PostgreSQL 17+): caps the whole transaction.

Set them per role or per transaction, not in `postgresql.conf`, where they would also hit migrations and maintenance:

```sql
ALTER ROLE booking_app SET statement_timeout = '5s';
ALTER ROLE booking_app SET lock_timeout = '2s';
ALTER ROLE booking_app SET idle_in_transaction_session_timeout = '30s';

BEGIN;
SET LOCAL lock_timeout = '500ms';   -- this transaction only; reverts at COMMIT/ROLLBACK
SELECT ... FOR UPDATE;
COMMIT;
```

Keep `lock_timeout` below `statement_timeout`, otherwise the statement timeout always fires first and the lock timeout is useless. In a request path, a short lock timeout turns a pile-up behind a stuck transaction into fast 503s instead of exhausted connection pools.

**Pitfalls**

- Using `FOR UPDATE` by habit when `FOR NO KEY UPDATE` would do. It needlessly blocks foreign key checks from child inserts.
- Using SKIP LOCKED to read business data. You get a partial answer with no error.
- Forgetting that role-level timeouts also apply to migrations run as that role. A short `lock_timeout` is actually good for `ALTER TABLE` (it fails fast instead of queueing every query behind it), but choose it on purpose.
- Not handling `55P03` and `57014`. Map them to 503 or 409 deliberately, not to a generic 500.

## 7. Deadlocks

A deadlock is a cycle of waits: T1 holds lock A and waits for B, while T2 holds B and waits for A. Neither can proceed, ever. Postgres breaks the cycle by aborting one of them.

### How they arise in a booking system

The common case is two transactions locking the same rows in opposite order. Imagine a "swap booking" endpoint that moves a user from event 1 to event 2 (increment one counter, decrement the other), and a second user swapping the other way at the same moment:

```sql
-- T1: swap 1 -> 2                       -- T2: swap 2 -> 1
BEGIN;                                   BEGIN;
UPDATE events SET seats_left = seats_left + 1 WHERE id = 1;   -- T1 locks row 1
                                         UPDATE events SET seats_left = seats_left + 1 WHERE id = 2;  -- T2 locks row 2
UPDATE events SET seats_left = seats_left - 1 WHERE id = 2;   -- T1 waits for T2
                                         UPDATE events SET seats_left = seats_left - 1 WHERE id = 1;  -- T2 waits for T1: cycle
```

Other sources: a batch job that updates many events in arbitrary order; a foreign key check (`FOR KEY SHARE` on the parent) mixed with an UPDATE of the parent in another order; two inserts racing on the same unique key in multi-row transactions.

### How Postgres detects them

Waiting is cheap, but searching for cycles is not, so Postgres does not check on every wait. A backend that has been waiting for a lock for `deadlock_timeout` (default 1 second) runs the deadlock detector. If it finds a cycle, it cancels one transaction with:

```text
ERROR:  deadlock detected
SQLSTATE: 40P01
DETAIL:  Process 1234 waits for ShareLock on transaction 5678; blocked by process 4321. ...
```

The other transaction then gets its lock and carries on. Which one dies is not predictable; do not design around it. In my test with asyncpg, one of the two transactions failed with `40P01` after about a second and the other committed.

Two consequences: a deadlock costs at least `deadlock_timeout` of latency for both requests, and the survivor's lock wait shows up as a slow request, not an error. Set `log_lock_waits = on` to see waits longer than `deadlock_timeout` in the server log.

### Prevention: consistent lock ordering

If every transaction acquires row locks in the same global order, no cycle can form. For the swap endpoint, lock both rows up front, sorted by id:

```python
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def swap_booking(session: AsyncSession, user_id: int, from_id: int, to_id: int) -> None:
    ids = sorted({from_id, to_id})
    rows = await session.execute(
        select(Event).where(Event.id.in_(ids)).order_by(Event.id).with_for_update(key_share=True)
    )
    events = {e.id: e for e in rows.scalars()}
    if events[to_id].seats_left <= 0:
        raise SoldOut(to_id)
    events[to_id].seats_left -= 1
    events[from_id].seats_left += 1
    # ... move the booking row
```

Other habits that help:

- Take the strongest lock you will need first. Upgrading `FOR SHARE` to `FOR UPDATE` later is a classic two-party deadlock.
- Keep transactions short so the window for a cycle is small.
- In bulk updates, sort the keys (`ORDER BY id` in the locking subquery).

### Recovery: retry

You cannot always prove ordering (ORM flush order, FK checks, triggers). So treat `40P01` like `40001`: roll back and retry the whole transaction, a small number of times, with jittered backoff. Section 8 shows a decorator that handles both.

**Pitfalls**

- Treating a deadlock as a bug only. It can be, but under real load a few are normal; an occasional `40P01` with a retry is fine.
- Relying on `ORDER BY` inside the same statement that locks under Read Committed: rows are sorted before locking, so ordering can be subtly off if keys change. Lock by primary key, which does not change.
- Lowering `deadlock_timeout` aggressively. Detection runs more often and costs CPU; the default is fine for most apps.
- Retrying without a cap. A logic error that deadlocks every time becomes an infinite loop.

## 8. Doing it from Python: SQLAlchemy 2.0 async

The database does the hard work. Your Python job is to draw transaction boundaries in the right place, set the isolation level before the first query, recognise retryable errors by SQLSTATE, and retry the whole unit of work.

### Engine, session factory, transaction boundaries

```python
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

engine = create_async_engine(
    "postgresql+asyncpg://booking:booking@db:5432/booking",
    pool_size=20,
    max_overflow=10,
    pool_pre_ping=True,
)
SessionFactory = async_sessionmaker(engine, expire_on_commit=False)
```

`expire_on_commit=False` matters in async code. With the default, a commit expires every loaded attribute, and touching one afterwards would trigger lazy I/O, which async SQLAlchemy cannot do implicitly.

The canonical unit of work:

```python
async def create_booking(event_id: int, user_id: int) -> int:
    async with SessionFactory() as session:        # checks out a connection lazily
        async with session.begin():                # BEGIN ... COMMIT, or ROLLBACK on exception
            return await reserve_seat(session, event_id, user_id)
```

On normal exit, `session.begin()` flushes and commits. On any exception it rolls back and re-raises. Keep the block tight: everything inside holds a connection and, after the UPDATE, a row lock. Produce to Kafka (or write the outbox row) as part of the transaction only via the outbox; do the network call after the block.

In FastAPI, a common pattern is one session per request via a dependency, and the service decides where `begin()` goes:

```python
from collections.abc import AsyncIterator


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionFactory() as session:
        yield session
```

### Locking reads

```python
stmt = select(Event).where(Event.id == event_id).with_for_update(key_share=True)  # FOR NO KEY UPDATE
event = (await session.execute(stmt)).scalar_one()
```

The lock is held until the enclosing transaction ends. Section 6 has the full mapping of `with_for_update` arguments.

### Setting the isolation level

Three scopes, from broad to narrow. All of them must take effect before the transaction's first statement.

```python
# 1. Whole engine (every connection from this pool)
engine = create_async_engine(DSN, isolation_level="REPEATABLE READ")

# 2. A second engine sharing the same pool, for a group of operations
serializable_engine = engine.execution_options(isolation_level="SERIALIZABLE")
SerializableSession = async_sessionmaker(serializable_engine, expire_on_commit=False)

# 3. One transaction: call session.connection() first, before any query
async with SessionFactory() as session, session.begin():
    await session.connection(execution_options={"isolation_level": "SERIALIZABLE"})
    ...  # queries here run at SERIALIZABLE

# Core equivalent on a connection
async with engine.connect() as conn:
    conn = await conn.execution_options(isolation_level="SERIALIZABLE")
    async with conn.begin():
        ...
```

SQLAlchemy resets the level when the connection returns to the pool. I verified option 3 with `SHOW transaction_isolation`, which returned `serializable` inside the block.

### Recognising retryable errors

SQLAlchemy wraps driver errors. The original driver exception is on `exc.orig`.

- With **asyncpg**, SQLAlchemy's adapter exposes `exc.orig.sqlstate` (and `pgcode`), and the raw asyncpg exception (for example `asyncpg.exceptions.SerializationError`, `DeadlockDetectedError`, `UniqueViolationError`) is `exc.orig.__cause__`. In my tests a serialization failure arrived as a plain `sqlalchemy.exc.DBAPIError`, not `OperationalError`, so do not catch by wrapper class.
- With **psycopg 3**, `exc.orig` is the psycopg exception itself, e.g. `psycopg.errors.SerializationFailure` or `DeadlockDetected`, with `.sqlstate` and `.diag.constraint_name`.

So the portable test is the SQLSTATE string:

| SQLSTATE | Meaning | What to do |
| --- | --- | --- |
| `40001` | serialization\_failure | Retry the whole transaction |
| `40P01` | deadlock\_detected | Retry the whole transaction |
| `23505` | unique\_violation | Usually a business error (409); do not blind-retry |
| `23514` | check\_violation | Bug or race your logic missed; log, 409 or 500 |
| `55P03` | lock\_not\_available (NOWAIT, lock\_timeout) | 409 or 503, optionally retry once |
| `57014` | query\_canceled (statement\_timeout) | 503; investigate |

```python
from sqlalchemy.exc import DBAPIError

RETRYABLE_SQLSTATES: frozenset[str] = frozenset({"40001", "40P01"})


def sqlstate_of(exc: DBAPIError) -> str | None:
    orig = exc.orig
    return getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)
```

### A retry decorator with backoff

The decorated function must own the whole transaction: open the session, begin, read, decide, write, commit. Retrying inside an open transaction is useless, because Postgres has already aborted it.

```python
import asyncio
import functools
import logging
import random
from collections.abc import Awaitable, Callable

log = logging.getLogger(__name__)


def retry_on_serialization_failure[**P, R](
    attempts: int = 5,
    base_delay: float = 0.02,
    max_delay: float = 0.5,
) -> Callable[[Callable[P, Awaitable[R]]], Callable[P, Awaitable[R]]]:
    def decorator(fn: Callable[P, Awaitable[R]]) -> Callable[P, Awaitable[R]]:
        @functools.wraps(fn)
        async def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            for attempt in range(1, attempts + 1):
                try:
                    return await fn(*args, **kwargs)
                except DBAPIError as exc:
                    code = sqlstate_of(exc)
                    if code not in RETRYABLE_SQLSTATES or attempt == attempts:
                        raise
                    delay = min(max_delay, base_delay * 2 ** (attempt - 1))
                    delay *= random.uniform(0.5, 1.5)          # jitter: avoid lockstep retries
                    log.info("retrying %s after %s (attempt %d)", fn.__name__, code, attempt)
                    await asyncio.sleep(delay)
            raise AssertionError("unreachable")
        return wrapper
    return decorator
```

The `[**P, R]` syntax is the Python 3.12 type parameter form; it keeps the wrapped function's signature for type checkers. If you prefer a library, `tenacity` does the same with `retry_if_exception(...)` and `wait_random_exponential`.

Usage:

```python
@retry_on_serialization_failure(attempts=8)
async def book_serializable(event_id: int, user_id: int) -> int:
    async with SerializableSession() as session, session.begin():
        ...  # read, check, write: everything recomputed on each attempt
```

**Pitfalls**

- Sharing one `AsyncSession` across concurrent tasks (`asyncio.gather` over the same session). It is not safe; each task needs its own session.
- Setting `execution_options(isolation_level=...)` after a query has already run in that transaction. It cannot change the level of a running transaction.
- Catching `OperationalError` to find serialization failures. With asyncpg they arrive as plain `DBAPIError`. Check SQLSTATE.
- Decorating a function that receives an existing session. The retry would re-run work inside an already aborted transaction.
- Side effects inside the retried function (emails, Kafka produce). They repeat on every attempt. Use the outbox.

## 9. Testing concurrency for real

A concurrency guarantee is only as good as the test that tries to break it. The test must create real contention: many transactions, on separate connections, hitting the same row at the same moment, against a real Postgres.

### Why it must be real Postgres and separate connections

- **SQLite or mocks prove nothing.** SQLite locks the whole database file and has different isolation semantics. The bug you are guarding against lives in Postgres row locking and MVCC.
- **One session means one connection means one transaction.** If 50 coroutines share a session, their statements run one after another inside a single transaction. There is no concurrency to test, and SQLAlchemy will likely raise errors about concurrent operations on the session. Each attempt needs its own `AsyncSession`, which checks out its own pooled connection.
- **The pool must be big enough.** With `pool_size=5`, only five transactions run at once and the rest queue in Python. That still tests correctness, but it hides contention. Size the test pool at or above the request count, and keep Postgres `max_connections` (default 100) in mind.
- **The common "wrap each test in a transaction and roll back" fixture does not work here.** That pattern shares one connection. For concurrency tests, commit for real and clean up afterwards (truncate, or a fresh database per test session).

### testcontainers fixture

`testcontainers` starts a throwaway Postgres in Docker for the test session. In current releases (4.x) the module lives at `testcontainers.postgres` and is being moved to `testcontainers.community.postgres`; check which import your installed version prefers. Pass `driver="asyncpg"` so the URL is ready for the async engine.

```python
# tests/conftest.py
from collections.abc import AsyncIterator, Iterator

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from testcontainers.postgres import PostgresContainer

from booking.db import Base


@pytest.fixture(scope="session")
def pg_url() -> Iterator[str]:
    with PostgresContainer("postgres:18", driver="asyncpg") as pg:
        yield pg.get_connection_url()


@pytest_asyncio.fixture(loop_scope="session", scope="session")
async def engine(pg_url: str) -> AsyncIterator[AsyncEngine]:
    eng = create_async_engine(pg_url, pool_size=60, max_overflow=0)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)   # or run your Alembic migrations
    yield eng
    await eng.dispose()
```

Running Alembic migrations instead of `create_all` is better: the test then also proves your migration created the CHECK and UNIQUE constraints.

### The 50-for-10 test

The outline below is the shape of the test, not the whole file. The key ideas: a start gate so all tasks hit the database together, one session per task, and assertions on both outcomes and final database state.

```python
import asyncio
from collections import Counter

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker


@pytest.mark.asyncio(loop_scope="session")
async def test_fifty_requests_for_ten_seats(engine: AsyncEngine) -> None:
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    event_id = await make_event(sessions, seats=10)          # your helper, commits
    gate = asyncio.Event()

    async def attempt(user_id: int) -> str:
        await gate.wait()                                     # everyone starts together
        try:
            await book(sessions, event_id, user_id)           # opens its own session
            return "booked"
        except SoldOut:
            return "sold_out"

    tasks = [asyncio.create_task(attempt(uid)) for uid in range(1, 51)]
    await asyncio.sleep(0)                                    # let tasks reach the gate
    gate.set()
    outcomes = Counter(await asyncio.gather(*tasks))

    assert outcomes == {"booked": 10, "sold_out": 40}
    # Also assert in the database: seats_left == 0 and exactly 10 booking rows.
```

I ran this shape against PostgreSQL 16 with the conditional-UPDATE service: 10 booked, 40 sold out, `seats_left = 0`, 10 rows. The same harness with a naive read-then-write booking function produced 50 "booked" results for a 10-seat event. Run the test against the broken version once on purpose; a concurrency test you have never seen fail is not yet trustworthy.

Useful extra cases:

- Same user, five simultaneous requests for the same event: exactly one booking, four duplicates, and `seats_left` dropped by one only.
- Repeat the main test in a loop (`pytest --count=20` with pytest-repeat) to shake out timing luck.
- For the HTTP layer, the same idea with `httpx.AsyncClient(transport=ASGITransport(app=app))`: assert ten 201s and forty 409s.

**Pitfalls**

- Using the transactional-rollback fixture for concurrency tests. All tasks end up on one connection.
- A pool smaller than the number of concurrent tasks, then concluding there is no contention.
- Asserting only on HTTP responses. Also check the database state, which is the invariant you actually care about.
- Event-loop scope mismatches in pytest-asyncio: an engine created in a session-scoped loop must be used from tests running in that same loop (`loop_scope="session"`).

## Apply it to the capstone

This week's Build tasks, in the order that makes each step testable. Hints and sketches only; the wiring is yours.

### Task 1: constraints first (migration)

Start with the backstop, so every later step is protected even if your code is wrong.

- [ ] Alembic migration: `CHECK (seats_left >= 0)` named `ck_events_seats_left_nonneg`.
- [ ] `UNIQUE (user_id, event_id)` named `uq_bookings_user_event`. The unique index it creates also serves "my bookings for this event" lookups (see the indexes notes).
- [ ] Add `capacity` alongside `seats_left` if you want to show "7 of 50 left"; then also `CHECK (seats_left <= capacity)`.

Hint: in the model, declare them in `__table_args__` with explicit `name=` so autogenerate and your error mapping agree on the names.

### Task 2: the booking service (no overselling)

Pick the conditional UPDATE (section 5a). Sketch of the shape:

```python
async def book_seat(session: AsyncSession, event_id: int, user_id: int) -> Booking:
    # 1. UPDATE events ... WHERE id = :event_id AND seats_left > 0 RETURNING seats_left
    # 2. no row?  -> decide: event missing (404) or sold out (SoldOut)
    # 3. INSERT booking ... RETURNING id, created_at
    # 4. INSERT outbox row for booking.created (same transaction)
    ...
```

Questions to answer in your code:

- Where does `async with session.begin()` live: in the route, the service, or a unit-of-work helper? One place only.
- What happens to the decremented seat if step 3 raises `IntegrityError`? (Answer: rolled back with the transaction. Write a test that proves it.)
- If you later add "sales window" or "max 4 tickets per user", switch to `with_for_update(key_share=True)` (5b) and keep the same tests.

### Task 3: 409 for sold out and duplicates

Keep HTTP out of the service. The service raises domain exceptions; FastAPI maps them.

```python
@app.exception_handler(SoldOut)
async def sold_out_handler(request: Request, exc: SoldOut) -> JSONResponse:
    return JSONResponse(status_code=409, content={"code": "sold_out", "event_id": exc.args[0]})

# same for AlreadyBooked -> 409 {"code": "already_booked"}
```

Hints:

- Translate `IntegrityError` to `AlreadyBooked` in the service by checking the constraint name (section 5e), not the message text.
- Use distinct error codes in the body so the client can tell "sold out" from "you already have a ticket".
- Decide what `55P03` and `57014` become (likely 503 with `Retry-After`). Set `lock_timeout` and `statement_timeout` on the app role in your Docker Compose init SQL.
- Should a duplicate request return 409 or the existing booking with 200? Both are defensible; idempotency keys are a later-week topic. Write down your choice.

### Task 4: the concurrency test

Follow section 9.

- [ ] Session-scoped `PostgresContainer` fixture, migrations applied with Alembic.
- [ ] Engine with `pool_size` of at least 50.
- [ ] 50 tasks, distinct users, start gate, one session each. Assert 10 booked, 40 sold out, `seats_left == 0`, 10 rows.
- [ ] Same user, 5 parallel requests: 1 booked, 4 duplicates, `seats_left` decreased by exactly 1.
- [ ] Temporarily swap in a naive read-then-write implementation and watch the test fail. Then revert.
- [ ] Optional: an HTTP-level version through `httpx.AsyncClient` asserting 10 x 201 and 40 x 409.

### Task 5 (stretch): the Kafka side

The notification worker consumes `booking.created`. Do not produce to Kafka inside the booking transaction.

- Insert an `outbox` row in the same transaction as the booking.
- A relay loop claims rows with `FOR UPDATE SKIP LOCKED` (section 6), publishes, marks them sent, commits.
- Consumers must be idempotent (the relay can publish twice after a crash). The unique booking id in the payload is your dedup key.

This is the same pattern you may know from Camunda or NestJS work as "transactional outbox"; here you build the relay by hand.

### Definition of done

- [ ] Constraints exist in the migration and are named.
- [ ] Booking runs in a single short transaction with no network calls inside.
- [ ] Sold out and duplicate both return 409 with distinct codes.
- [ ] The 50-for-10 test passes 20 runs in a row against real Postgres.
- [ ] You can explain, without notes, why the conditional UPDATE is safe under Read Committed.

## Check yourself

1. What physically happens to the old row when you run UPDATE in Postgres, and why does that make ROLLBACK cheap?
2. What does COMMIT have to wait for before it returns, and what changes with `synchronous_commit = off`?
3. Why does a plain SELECT never block an UPDATE in Postgres? What is the downside of that for a booking check?
4. In Read Committed, T1 and T2 both run `UPDATE events SET seats_left = seats_left - 1 WHERE id = 42 AND seats_left > 0` with one seat left. Walk through what each one sees and does.
5. What is the difference between a lost update and write skew? Which Postgres isolation levels prevent each?
6. Postgres Repeatable Read prevents phantoms even though the SQL standard allows them at that level. Why?
7. Your service runs at Serializable and returns HTTP 500 under load. What is probably missing?
8. When would you choose `SELECT ... FOR UPDATE` over a conditional UPDATE? When would you choose a version column over both?
9. Why do you still need `UNIQUE (user_id, event_id)` if your code checks for an existing booking first?
10. What is SKIP LOCKED for, and why is it wrong for counting available seats?
11. Two endpoints lock events in different orders and you see `40P01` in the logs. What happened, and what are two fixes?
12. Your concurrency test passes with 50 coroutines sharing one `AsyncSession`. Why is this result meaningless?

## Answers

1. Nothing is overwritten. The old tuple gets `xmax` set to the updating transaction id, and a new tuple is written with `xmin` set to it. Visibility depends on the transaction's status in the commit log, so ROLLBACK only marks the transaction aborted; its tuples become invisible and VACUUM removes them later.
2. The WAL records up to the commit record must be flushed to durable storage. Data pages are written later. With `synchronous_commit = off`, COMMIT returns before the flush, so a crash can lose the most recent commits, but the database stays consistent.
3. MVCC: the reader picks the version visible to its snapshot and takes no row lock, and the writer creates a new version without touching the old one. The downside: a SELECT that saw a free seat reserved nothing, so a check-then-write sequence can act on stale data.
4. T1 locks the row, sets it to 0, returns one row. T2 finds the row through its snapshot, sees it is being updated, and waits. When T1 commits, T2 re-reads the newest version, re-checks `seats_left > 0`, finds 0, and updates zero rows. T2 reports sold out. No oversell.
5. A lost update is two transactions writing the same row, where one write is based on a stale read and silently overwrites the other. Write skew is two transactions reading overlapping data and writing different rows, jointly breaking a rule. In Postgres, Repeatable Read and Serializable both stop lost updates (with `40001`); only Serializable stops write skew.
6. Because Repeatable Read uses one snapshot for the whole transaction. Rows inserted by others after the snapshot are invisible, so a repeated range query returns the same set.
7. A retry loop for SQLSTATE `40001` (and `40P01`). Serializable is designed to abort transactions; the app must retry the whole transaction with backoff.
8. FOR UPDATE when the decision needs more than a single WHERE condition (quotas, sales windows, multiple fields) and you need to run Python logic while the row cannot change. A version column when conflicts are rare and the read-to-write gap is long, such as a form edit, where holding a lock would be unacceptable.
9. Two concurrent requests from the same user can both pass the existence check before either inserts. Only the unique index serialises them: the second insert waits, then fails with `23505`. Constraints hold across all code paths and bugs.
10. It lets several workers claim different rows of a queue (like an outbox) without waiting for each other. It silently skips locked rows, so any count or business read using it can be wrong without an error.
11. A deadlock: each transaction held a lock the other needed. Postgres detected the cycle after `deadlock_timeout` and aborted one. Fix by locking rows in a consistent order (for example sorted by id) and by retrying `40P01` with backoff.
12. One session means one connection and one transaction, so the statements ran one after another. There was no real contention. Each concurrent attempt needs its own session and connection.

## Sources

PostgreSQL docs are the current release (18). The demos in these notes were run on a local PostgreSQL 16.15 with SQLAlchemy 2.1.6 and asyncpg 0.32; the behaviours shown are the same across 16 to 18.

- PostgreSQL: [13.1 Concurrency Control, Introduction](https://www.postgresql.org/docs/current/mvcc-intro.html)
- PostgreSQL: [13.2 Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- PostgreSQL: [13.3 Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- PostgreSQL: [13.5 Serialization Failure Handling](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html)
- PostgreSQL: [SELECT, the locking clause](https://www.postgresql.org/docs/current/sql-select.html)
- PostgreSQL: [28.3 Write-Ahead Logging](https://www.postgresql.org/docs/current/wal-intro.html)
- PostgreSQL: [24.1 Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- PostgreSQL: [Client connection defaults (timeouts)](https://www.postgresql.org/docs/current/runtime-config-client.html)
- The Internals of PostgreSQL: [Chapter 5, Concurrency Control](https://www.interdb.jp/pg/pgsql05.html) and [5.3 Inserting, Deleting and Updating Tuples](https://www.interdb.jp/pg/pgsql05/03.html)
- SQLAlchemy 2.0: [Transactions and Connection Management (ORM)](https://docs.sqlalchemy.org/en/20/orm/session_transaction.html)
- SQLAlchemy 2.0: [Asynchronous I/O (asyncio)](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html)
- psycopg 3: [psycopg.errors](https://www.psycopg.org/psycopg3/docs/api/errors.html)
- testcontainers-python: [Postgres module](https://testcontainers-python.readthedocs.io/en/latest/modules/postgres/README.html)

Go deeper next: read 13.2 end to end (it has a worked SSI example), then chapter 5 of The Internals of PostgreSQL for visibility rules and snapshot internals.
