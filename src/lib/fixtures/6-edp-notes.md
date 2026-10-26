# Study Notes — Week 6: Reliable Event-Driven Patterns

Oct 23, 2026 · @Mathew Matholomew

After this week you will be able to explain why writing to Postgres and Kafka from the same request handler is unsafe, and fix it with a transactional outbox plus idempotent consumers. You will also know how to route failing messages through retry and dead-letter topics, design events that can evolve, choose between saga styles, and shut a worker down without losing or duplicating work. The capstone section turns all of this into the event-booking API's outbox, relay, retry/DLT topology and a graceful `booking.created` worker.

## 1. The dual-write problem

A dual write is any code path that changes two independent systems and assumes both will succeed. Postgres and Kafka cannot share a transaction, so there is always a moment where one write is durable and the other is not. A crash, timeout or network split in that moment leaves them disagreeing, and nothing will repair it later.

The naive booking handler looks harmless:

```python
async def book_seat(session: AsyncSession, producer: Producer, cmd: BookSeat) -> Booking:
    booking = Booking(event_id=cmd.event_id, seat_id=cmd.seat_id, user_id=cmd.user_id)
    session.add(booking)
    await session.commit()                       # write 1: Postgres
    producer.produce("booking.created",           # write 2: Kafka
                     key=str(booking.id), value=to_json(booking))
    producer.flush(5)
    return booking
```

### Timeline A: commit first, then produce (lost event)

1. `t0` Handler commits the booking. The seat is now taken in Postgres.
2. `t1` The pod is killed by a deploy, or Kafka is unreachable and `flush()` times out.
3. `t2` The client gets a 500 or a dropped connection. The booking row exists.
4. Result: a real booking with no `booking.created` event. The user is never notified, and any downstream service (payments, analytics) never hears about it.

### Timeline B: produce first, then commit (invented event)

1. `t0` Handler produces `booking.created`. The broker acknowledges it.
2. `t1` The commit fails: a unique-constraint violation on `(event_id, seat_id)` because someone else got the seat, a serialization failure, or a lost connection.
3. `t2` The transaction rolls back.
4. Result: consumers act on a booking that does not exist. The worker emails a confirmation for a seat the user does not have.

### Timeline C: the ambiguous timeout

Even with the order chosen carefully, a timeout does not tell you what happened. If `produce` times out, the broker may or may not have written the record. If you retry, you may duplicate. If you give up, you may lose it. The same ambiguity exists for a commit whose acknowledgement is lost on the wire.

### Why the obvious fixes do not work

- **Wrap the produce in the DB transaction.** Producing inside `async with session.begin()` and committing after still allows Timeline B. The broker write is not rolled back with the database.
- **Kafka transactions.** They make writes across Kafka partitions atomic. They do not include your Postgres database. Your sibling Kafka-core notes cover what EOS does and does not span.
- **Two-phase commit (XA).** Kafka does not participate in XA, and 2PC couples availability of both systems anyway.
- **Retry until it works.** Retries help with transient errors but cannot survive the process dying between the two writes.

The fix is to make only ONE write atomic, to the database, and derive the Kafka write from it later. That is the outbox.

### Pitfalls

- Assuming "it almost never happens". Deploys, OOM kills and broker leader elections make it happen weekly at moderate traffic.
- Treating `producer.produce()` returning as success. It only enqueues locally; the delivery callback or `flush()` tells you the broker accepted it.
- Publishing from an SQLAlchemy `after_commit` event hook. It is still Timeline A, just hidden.

## 2. Transactional outbox

The outbox turns two writes into one. The booking handler inserts the booking AND a row describing the event into an `outbox` table, in the same Postgres transaction. Either both commit or neither does. A separate relay process later reads unpublished outbox rows and produces them to Kafka. microservices.io sums it up as writing the event "to a database OUTBOX table as part of the transaction".

Two properties follow directly. An event exists if and only if the business change committed, which kills Timelines A and B. And publishing becomes at-least-once: the relay can crash after Kafka acknowledged a batch but before it marked the rows published, so it will send them again. That is why section 3 (idempotent consumers) is not optional.

&#91;embedded content: outbox architecture · API to worker\]

Only the Postgres commit is atomic; everything to its right can repeat, which is why the worker dedupes.

### The table

```sql
CREATE TABLE outbox (
    id            uuid        PRIMARY KEY,               -- becomes event_id in the envelope
    seq           bigint      GENERATED ALWAYS AS IDENTITY,
    aggregate_type text       NOT NULL,                  -- 'booking'
    aggregate_id  text        NOT NULL,                  -- booking id; used as the Kafka key
    event_type    text        NOT NULL,                  -- 'booking.created'
    payload       jsonb       NOT NULL,
    headers       jsonb       NOT NULL DEFAULT '{}',     -- correlation_id, traceparent
    created_at    timestamptz NOT NULL DEFAULT now(),
    published_at  timestamptz
);

-- The relay only ever scans unpublished rows; keep that index tiny.
CREATE INDEX outbox_unpublished_idx ON outbox (seq) WHERE published_at IS NULL;
```

Why `seq` in addition to `created_at`: `now()` returns the transaction start time, so two events written in one transaction get the same timestamp. A monotonically increasing identity gives a stable tiebreak within one aggregate.

### Writing it in the booking transaction

```python
from uuid import uuid4
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

async def book_seat(session: AsyncSession, cmd: BookSeat, correlation_id: str) -> Booking:
    async with session.begin():                      # ONE transaction
        seat = await session.scalar(
            select(Seat).where(Seat.id == cmd.seat_id).with_for_update()
        )
        if seat is None or seat.booked:
            raise SeatUnavailable(cmd.seat_id)
        seat.booked = True
        booking = Booking(id=uuid4(), seat_id=seat.id, user_id=cmd.user_id)
        session.add(booking)
        await session.execute(insert(Outbox).values(
            id=uuid4(),
            aggregate_type="booking",
            aggregate_id=str(booking.id),
            event_type="booking.created",
            payload={"booking_id": str(booking.id), "seat_id": str(seat.id),
                     "show_id": str(seat.show_id), "user_id": str(cmd.user_id)},
            headers={"correlation_id": correlation_id},
        ))
    return booking   # no Kafka call here at all
```

The handler never touches Kafka. If anything raises inside the block, SQLAlchemy rolls back the seat update, the booking and the outbox row together.

### The relay (polling publisher)

The relay loops: claim a batch, produce it, wait for acknowledgements, mark the batch published, commit.

```sql
SELECT id, aggregate_id, event_type, payload, headers
FROM outbox
WHERE published_at IS NULL
ORDER BY seq
LIMIT 200
FOR UPDATE SKIP LOCKED;
```

`FOR UPDATE` locks the selected rows until the relay's transaction ends. `SKIP LOCKED` makes a second relay instance skip rows already claimed instead of waiting for them. So you can run two relays for availability without both publishing the same rows at the same time.

```python
async def relay_once(session: AsyncSession, producer: Producer, topic_for: Callable[[str], str]) -> int:
    async with session.begin():
        rows = (await session.execute(CLAIM_BATCH_SQL)).all()
        if not rows:
            return 0
        failures: list[KafkaError] = []

        def on_delivery(err: KafkaError | None, msg: Message) -> None:
            if err is not None:
                failures.append(err)

        for r in rows:
            producer.produce(
                topic_for(r.event_type),
                key=r.aggregate_id,
                value=json.dumps(envelope(r)).encode(),
                headers=[("event_id", str(r.id)), *encode_headers(r.headers)],
                on_delivery=on_delivery,
            )
        remaining = producer.flush(10)          # blocks; run in a thread in async code
        if remaining or failures:
            raise RelayError("batch not fully acknowledged")   # rollback: rows stay unpublished
        await session.execute(
            update(Outbox).where(Outbox.id.in_([r.id for r in rows]))
                          .values(published_at=func.now())
        )
    return len(rows)
```

Notes on the sketch: `producer.flush()` is blocking, so in an asyncio process wrap it with `asyncio.to_thread`. Configure the producer with `enable.idempotence=True` and `acks=all` so broker-side retries do not reorder or duplicate within a partition. Sleep briefly (100–500 ms) when a batch comes back empty.

**Mark or delete?** Marking `published_at` keeps an audit trail and makes replay easy, but the table grows; a nightly job deletes rows older than N days. Deleting rows inside the relay transaction keeps the table small but loses history. Both are fine; pick one and make cleanup part of the design.

### Ordering per aggregate

Kafka only orders records within one partition. Using `aggregate_id` as the key sends all events for one booking to one partition, so consumers see `booking.created` before `booking.cancelled`. The relay must not break that order before Kafka even sees it:

- With one relay instance and `ORDER BY seq`, events for one aggregate are produced in commit order (close enough; see pitfalls).
- With several relays and `SKIP LOCKED`, relay A may hold `created` while relay B grabs `cancelled` and publishes it first. If per-aggregate order matters, either run one active relay (a Postgres advisory lock as leader election is the simplest way), or shard relays by `hashtext(aggregate_id) % N`.

### Change data capture with Debezium (the alternative)

Instead of polling, Debezium reads Postgres's write-ahead log through logical replication and turns each committed insert into the outbox into a Kafka record. Its Outbox Event Router transform (`io.debezium.transforms.outbox.EventRouter`) expects columns like `id`, `aggregatetype`, `aggregateid`, `type` and `payload`. By default it routes to a topic named `outbox.event.<aggregatetype>`, uses `aggregateid` as the key and copies `id` into a header. The Debezium team's blog even inserts and deletes the outbox row in the same transaction: the log still contains the insert, so the table stays empty.

|  | Polling relay | CDC (Debezium) |
| --- | --- | --- |
| Latency | Poll interval (100 ms–1 s) | Near real time from the WAL |
| DB load | Repeated queries and updates on `outbox` | Reads the replication stream; no extra queries |
| Moving parts | One small Python process you own | Kafka Connect cluster, connector config, replication slot |
| Ordering | Your job (single relay or sharding) | Follows commit order in the WAL |
| Operational risk | Low; easy to debug with SQL | An abandoned replication slot makes Postgres retain WAL and fill the disk |
| Delivery | At-least-once | At-least-once (duplicates after connector restarts) |
| Fits the capstone? | Yes; teaches the mechanics | Worth a stretch goal once polling works |

### Pitfalls

- Forgetting that the relay duplicates. Every consumer must dedupe on `event_id`.
- Producing with no key, or with `seat_id` as the key while cancellations key on `booking_id`. Pick one aggregate key per stream.
- Polling with `WHERE seq > :last_seen`. A transaction that got a lower `seq` but commits later is skipped forever. Query on `published_at IS NULL` instead.
- Holding the claim transaction open across a long Kafka outage. Bound `flush()` with a timeout and let the batch roll back.
- Letting the outbox grow unbounded. A table with 50 million published rows makes vacuum and backups slow.

## 3. Idempotent consumers

An idempotent consumer produces the same end state whether it sees a message once or five times. You need it because duplicates come from at least four places in this system, and you cannot remove all of them:

- The outbox relay re-sends a batch after crashing between the Kafka ack and the `published_at` update.
- The producer retries after a timeout whose ack was actually written (idempotent producers fix this within one producer session only).
- The consumer processes a message, then crashes or is rebalanced before committing its offset. The next owner of the partition reprocesses it.
- Someone replays a dead-letter topic or resets a consumer group's offsets on purpose.

Kafka's exactly-once semantics cover read-process-write loops that stay inside Kafka. Sending an email or writing to Postgres is outside that boundary, so the consumer has to dedupe by itself.

### The processed-messages table

Give every event a unique `event_id` (the outbox row's `id`). The consumer records each id it has handled, and a unique constraint turns the second attempt into a no-op.

```sql
CREATE TABLE processed_messages (
    consumer_name text        NOT NULL,          -- 'notification-worker'
    event_id      uuid        NOT NULL,
    processed_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer_name, event_id)
);
```

`consumer_name` is part of the key because two different consumers of the same topic each need to process the event once. The notification worker and an analytics worker must not dedupe against each other.

### Side effect and dedupe insert in one transaction

The crucial rule: the dedupe insert and the side effect must commit together. If you insert the marker first and then crash before the side effect, the event is silently dropped. If you do the side effect first and crash before the marker, you get a duplicate. Put both in one database transaction:

```python
from sqlalchemy.dialects.postgresql import insert as pg_insert

CONSUMER = "notification-worker"

async def handle_booking_created(session: AsyncSession, env: Envelope) -> None:
    async with session.begin():
        claimed = await session.scalar(
            pg_insert(ProcessedMessage)
            .values(consumer_name=CONSUMER, event_id=env.event_id)
            .on_conflict_do_nothing()
            .returning(ProcessedMessage.event_id)
        )
        if claimed is None:
            return                                    # duplicate: already done
        await session.execute(insert(Notification).values(
            booking_id=env.payload["booking_id"],
            user_id=env.payload["user_id"],
            kind="booking_confirmation",
            status="pending",
        ))
    # offset is committed only after this function returns
```

`ON CONFLICT DO NOTHING ... RETURNING` returns no row on a duplicate, which is a cheap and race-free check. Two workers racing on the same event both try the insert; Postgres lets one win and blocks the other until the first commits, after which the second sees the conflict.

### When the side effect is not in your database

Sending an email through an external API cannot join your transaction. Two honest options:

1. **Write an intent, then act.** The transaction above records a `notifications` row with `status='pending'`. A separate step sends the email and flips the row to `sent`. The send can still happen twice if it crashes after sending, but you have narrowed the window to one call.
2. **Pass an idempotency key downstream.** Many email and payment APIs accept an idempotency key header. Use `event_id` (or `booking_id` + kind). The provider then dedupes for you.

### Natural idempotency

Some operations are idempotent without a table, and those are the cheapest to keep correct:

- `UPDATE bookings SET status='confirmed' WHERE id=:id` can run twice safely.
- `INSERT ... ON CONFLICT (booking_id, kind) DO NOTHING` on a table whose own unique key already identifies the effect.
- Upserts that overwrite with the latest version, guarded by `WHERE version < :new_version` so an older replay cannot overwrite newer state.

Increments (`seats_left = seats_left - 1`), appends and "send a message" are NOT naturally idempotent. Those need the explicit table.

### Dedupe windows

The processed-messages table grows forever unless you prune it. Delete rows older than a window, for example 7 days, matched to the longest time a duplicate could realistically arrive. Topic retention is a good upper bound: a message older than the topic's `retention.ms` cannot be redelivered from Kafka. If you replay a DLT that is older than your window, re-check against business state rather than relying on the table.

An in-memory or Redis set with a TTL is a faster dedupe store, but it is not atomic with your Postgres side effect. Use it as a pre-filter at most.

### Pitfalls

- Using the Kafka offset as the dedupe key. Offsets change if the event is republished by the relay or routed through a retry topic. Use `event_id`.
- Generating `event_id` in the relay at publish time. A re-sent batch then gets new ids, and dedupe sees two distinct events. Generate it when the outbox row is written.
- Checking with `SELECT` then inserting. Two workers can both see "not processed". Let the unique constraint decide.
- Committing the Kafka offset before the DB transaction commits. That is at-most-once, not idempotent at-least-once.

## 4. Retries and failure handling

A Kafka consumer reads a partition in order and commits one offset per partition. That design is what makes failure handling hard: if message 41 fails and you simply do not commit, message 42 cannot move past it. Every retry strategy is a choice about what to do with that blocked partition.

### Classify the error first

| Kind | Examples in the capstone | What helps |
| --- | --- | --- |
| Transient | Postgres connection reset, SMTP 503, lock timeout, Redis down | Waiting and trying again |
| Permanent (poison) | Invalid JSON, missing required field, unknown `version`, booking id that never existed | Nothing; retrying wastes time |
| Bug | `KeyError` from a code change, wrong type | A deploy, then a replay |

Encode the classification in exception types so the consumer loop can route without guessing:

```python
class TransientError(Exception): ...
class PermanentError(Exception): ...

def classify(exc: BaseException) -> type[Exception]:
    if isinstance(exc, (OperationalError, TimeoutError, ConnectionError)):
        return TransientError
    if isinstance(exc, (ValidationError, json.JSONDecodeError, PermanentError)):
        return PermanentError
    return TransientError     # unknown: give it a few tries, then the DLT catches it
```

### In-place retry with backoff

The simplest option: retry inside the handler a few times with exponential backoff and jitter, then give up.

```python
async def with_backoff(fn: Callable[[], Awaitable[None]], attempts: int = 3) -> None:
    for n in range(attempts):
        try:
            return await fn()
        except TransientError:
            if n == attempts - 1:
                raise
            await asyncio.sleep(min(0.2 * 2 ** n, 2.0) + random.random() * 0.1)
```

This is correct for blips lasting a second or two. It is wrong for long outages, for two reasons. First, the whole partition waits, so one bad message delays every booking behind it. Second, if a single poll iteration takes longer than `max.poll.interval.ms` (5 minutes by default), the broker assumes the consumer is dead, rebalances, and another consumer reprocesses the same message. Keep in-place retries to seconds, not minutes.

### Retry topics with delays (non-blocking retries)

Instead of blocking, the consumer republishes the failed message to a separate topic and commits the original offset. The main partition keeps flowing. A retry consumer reads the retry topic and processes the message once its delay has passed.

A common layout for the capstone:

- `booking.created` (main) → on transient failure, produce to `booking.created.retry.10s`
- `booking.created.retry.10s` → on failure, produce to `booking.created.retry.1m`
- `booking.created.retry.1m` → on failure, produce to `booking.created.dlt`
- Permanent errors skip the ladder and go straight to `booking.created.dlt`

&#91;embedded content: retry and dead-letter topology · 2 retry levels, 1 DLT\]

Each hop commits the offset it came from, so no partition waits; the DLT is the only place a message rests.

How the delay works: Kafka has no delayed delivery. The retry consumer reads a message, compares `now` with the x-`retry-not-before` header, and if it is too early, it pauses the partition (`consumer.pause()`), sleeps, then `seek()`s back to that offset and `resume()`s. Because every message in a given retry topic has the same delay, messages become due in the order they arrived, so waiting on the head is enough. Spring Kafka's `@RetryableTopic` builds exactly this ladder for you; in Python you write it yourself.

### Dead-letter topics and poison messages

A poison message is one that will fail every time. Without a DLT, a poison message either blocks the partition forever (in-place retry) or circles the retry ladder until someone notices. The DLT is a parking lot: the message is moved aside with enough context to diagnose it, the offset is committed, and processing continues.

A DLT is only useful if the message carries its story. Put it in headers and leave the value byte-for-byte unchanged:

```python
def failure_headers(msg: Message, exc: BaseException, attempt: int) -> list[tuple[str, bytes]]:
    return [
        ("x-original-topic", msg.topic().encode()),
        ("x-original-partition", str(msg.partition()).encode()),
        ("x-original-offset", str(msg.offset()).encode()),
        ("x-attempt", str(attempt).encode()),
        ("x-exception-class", type(exc).__qualname__.encode()),
        ("x-exception-message", str(exc)[:500].encode()),
        ("x-failed-at", datetime.now(UTC).isoformat().encode()),
        ("x-retry-not-before", (datetime.now(UTC) + delay_for(attempt)).isoformat().encode()),
    ]

def route_failure(producer: Producer, msg: Message, exc: BaseException) -> None:
    attempt = header_int(msg, "x-attempt", default=0) + 1
    target = DLT if classify(exc) is PermanentError or attempt > MAX_ATTEMPTS else retry_topic_for(attempt)
    keep = [h for h in (msg.headers() or []) if not h[0].startswith("x-")]   # keep correlation_id, event_id
    producer.produce(target, key=msg.key(), value=msg.value(),
                     headers=keep + failure_headers(msg, exc, attempt))
    producer.flush(5)       # must be durable BEFORE committing the original offset
```

The last line matters. If you commit the original offset and then the DLT produce fails, the message is gone. Produce, confirm delivery, then commit.

### Replaying from a DLT

Once the cause is fixed (a deploy, a data repair), you replay. A small CLI reads the DLT from a chosen offset, strips the `x-` failure headers, and produces each message back to `x-original-topic` with the same key. Because consumers are idempotent (section 3), replaying a message that actually succeeded later is harmless. Keep DLT retention long (weeks) so there is time to investigate.

### The ordering trade-off

Retry topics buy throughput by giving up per-key order. If `booking.created` for booking 7 goes to the retry ladder, `booking.cancelled` for booking 7 can be processed first on the main topic. Confluent's error-handling article warns of exactly this: "Events are not guaranteed to be processed in the same sequence". Options:

- Accept it, and make handlers tolerate it (a cancellation for an unknown booking is parked or retried, not dropped).
- Block in place for that partition when order is essential, and alert on lag.
- Track keys currently in the retry path and divert later events for the same key behind them. It keeps order per key but adds state you must persist.

For notifications, accepting reordering is usually fine. For payments or seat inventory, it often is not.

### Pitfalls

- Retrying permanent errors. Validation failures will fail identically 5 times; send them straight to the DLT.
- A single shared retry topic with mixed delays. A 1-minute message at the head blocks 10-second messages behind it.
- Losing the key when republishing. The retry and DLT messages lose partition affinity and debugging gets harder.
- No alert on the DLT. A DLT that fills silently is just a slower way to lose data. Alert on any non-zero inflow.
- Unbounded in-place retries that exceed `max.poll.interval.ms` and trigger rebalance storms.

## 5. Event design

An event is a public contract. Once another team's consumer depends on its shape, changing it costs coordination. A few rules made early save a lot of that.

### Naming: facts in the past tense

An event states something that already happened and cannot be refused: `booking.created`, `booking.cancelled`, `payment.captured`, `seat.released`. A command asks for something that may be refused: `CreateBooking`, `CapturePayment`. Keep them apart. If the name is imperative, the producer is really calling a remote procedure through Kafka, and the coupling just moved.

Pick one convention for topics and types and stick to it. A workable one: topic per aggregate stream (`bookings`), with `type` in the envelope distinguishing `booking.created` from `booking.cancelled`. Putting every type for one aggregate on one topic keeps them ordered per key. The capstone brief uses a topic named `booking.created`; that is fine for a single event type, but think about where `booking.cancelled` will go before you add it.

### The envelope

Wrap every payload in the same outer structure, so infrastructure code (dedupe, routing, tracing, DLT tooling) can work without knowing the payload.

```python
from datetime import datetime
from typing import Any, Literal
from uuid import UUID
from pydantic import BaseModel

class Envelope(BaseModel):
    event_id: UUID                     # unique per event; the dedupe key
    type: str                          # 'booking.created'
    version: int = 1                   # schema version of payload
    occurred_at: datetime              # when the fact happened (business time)
    producer: str = "booking-api"
    aggregate_id: str                  # also the Kafka key
    correlation_id: str | None = None  # ties the event to the HTTP request or saga
    payload: dict[str, Any]

class BookingCreatedV1(BaseModel):
    booking_id: UUID
    show_id: UUID           # the concert being booked, not the message
    seat_id: UUID
    user_id: UUID
    price_minor: int        # 1500000 = 15 000.00 KZT; never floats for money
    currency: Literal["KZT", "USD"]
```

Note the naming clash: in the capstone, "event" also means the concert being booked. Reserve `event_id` for the envelope and call the domain thing `show_id` in payloads. It removes a whole class of bugs.

`occurred_at` is the business time; Kafka's record timestamp is when it was produced. With an outbox they differ by the relay delay, and with a DLT replay by days.

Envelope fields can live in the JSON body or in Kafka headers. Headers let routers and DLT tools read metadata without parsing the value. A practical split: `event_id`, `type` and `correlation_id` in headers AND in the body; everything else in the body.

### Schema evolution and compatibility

Producers and consumers deploy at different times, so for a while old code reads new events and new code reads old ones. Compatibility rules say which changes are safe:

| Mode | Guarantee | Safe changes | Who deploys first |
| --- | --- | --- | --- |
| Backward | New readers can read old data | Add optional field with default; remove field | Consumers |
| Forward | Old readers can read new data | Add field; remove optional field with default | Producers |
| Full | Both | Add or remove optional fields with defaults | Either |

Confluent Schema Registry defaults to BACKWARD. The `_TRANSITIVE` variants check against all previous versions, not just the last one; that matters when consumers replay months of history from a compacted topic.

With Avro or Protobuf, the producer serializer registers the schema under a subject and the registry rejects incompatible changes at produce time. JSON Schema is supported too, but JSON's looseness makes "optional with a default" easy to get wrong. For the capstone, plain JSON plus a `version` field and Pydantic models per version is enough. Know the registry exists and why: it moves compatibility checks from code review to the pipeline.

Rules of thumb that hold regardless of format:

- Never change the meaning or type of an existing field. Add a new field instead.
- Never reuse a removed field's name.
- Consumers ignore unknown fields (Pydantic ignores extras by default; keep it that way).
- A truly breaking change gets a new type (`booking.created.v2`) or a new topic, published in parallel until consumers migrate.

### Fat vs thin events

- **Thin** (`{"booking_id": "..."}`): small, but every consumer calls back to the booking API to learn anything. That couples consumers to the producer's availability, and the data they fetch may already reflect later changes.
- **Fat** (event-carried state transfer): the payload holds what consumers need, such as seat, show, user, price. Consumers work offline and see the state as of the event. The cost is a larger contract to keep compatible, and possibly personal data spread across topics.

The usual middle ground: include the fields that describe the fact itself and that consumers commonly need, and nothing internal. For `booking.created`, the notification worker needs user id, show name and seat label; it should not need to call back.

### Pitfalls

- Generic events like `booking.updated` with a diff. Consumers must reverse-engineer intent. Prefer specific facts.
- Leaking the ORM model as the payload. Every column rename becomes a breaking change.
- Floats for money and naive datetimes. Use integer minor units and timezone-aware UTC.
- No `version` field in v1 "because there is only one version". You will need it.

## 6. Log compaction and retention

Every topic has a cleanup policy that decides when old records disappear. The choice depends on what the topic means: a stream of things that happened, or the current state of things.

### `cleanup.policy=delete` (the default)

The log is split into segment files. When a closed segment is older than `retention.ms` (default 7 days) or the partition exceeds `retention.bytes` (default unlimited), the whole segment is deleted. Records are removed by age, regardless of key. This fits event streams: `booking.created`, retry topics, and DLTs. A consumer that is down longer than the retention period loses data, so set retention well above your worst plausible outage, and longer for DLTs.

### `cleanup.policy=compact`

Compaction keeps, for each key, at least the latest value and removes older values for that key. The Confluent design docs phrase the guarantee as: "the latest value for each message key is always retained". Key facts about how it works:

- A background cleaner thread rewrites old segments, keeping the newest record per key. Order is preserved and offsets never change; compacted-away offsets are simply gaps.
- The active segment (the one being written) is never compacted. A low-traffic topic may not compact for `segment.ms` (default 7 days) unless you lower it.
- `min.cleanable.dirty.ratio` (default 0.5) controls how much duplicate data must accumulate before a cleaning run. `min.compaction.lag.ms` guarantees a record stays uncompacted for at least that long; `max.compaction.lag.ms` bounds how long it can wait.
- Compaction is not instant or deterministic. Consumers may still see several values for one key; they must treat the latest as truth.

### Tombstones

To delete a key from a compacted topic, produce a record with that key and a `null` value (not the string "null", not an empty JSON object). Compaction drops earlier values for the key, then keeps the tombstone for `delete.retention.ms` (default 1 day) so slower consumers can see the deletion, and then removes it too.

```python
# Seat state changelog: key = seat_id, value = latest state, None = seat removed
producer.produce("seat-state", key=str(seat_id), value=json.dumps({"status": "booked", "booking_id": str(bid)}).encode())
producer.produce("seat-state", key=str(seat_id), value=None)   # tombstone
```

A consumer bootstrapping from offset 0 must finish reading within `delete.retention.ms`; otherwise a tombstone might be cleaned before it sees it, and it would keep a stale value from an older segment it read earlier.

### Compacted topics as state

Because a compacted topic holds the latest value for every key, reading it from the start rebuilds a full table. Uses:

- **Changelogs**: Kafka Streams backs its state stores with compacted topics; a restarted instance restores state by replaying them.
- **Reference data**: a `shows` topic keyed by `show_id`, which other services consume into a local cache without calling your API.
- **Consumer-side snapshots**: a service that needs "current seat availability" builds it from a compacted `seat-state` topic.

`cleanup.policy=compact,delete` combines both: compacted per key, but also nothing older than `retention.ms`. Useful for state where very old keys can expire, such as session data.

### Which one when

| Topic | Policy | Why |
| --- | --- | --- |
| `booking.created` / `bookings` | delete, 7–30 days | Each event is a fact; consumers need every one, not just the last per key |
| Retry topics | delete, short (1–3 days) | Transit only |
| `booking.created.dlt` | delete, long (30+ days) | Time to investigate and replay |
| `seat-state`, `shows` | compact | Only the latest state per key matters |
| Debezium outbox topics | delete | They carry events; compacting would drop history for an aggregate |

### Pitfalls

- Compacting an event topic. `booking.created` then `booking.cancelled` with the same key: compaction may leave only the cancellation, and a new consumer never learns the booking existed.
- Producing to a compacted topic without keys. Compacted topics reject null keys.
- Expecting compaction as dedupe. It is eventual and best-effort; consumers still need idempotency.
- Forgetting that `retention.bytes` is per partition, not per topic.

## 7. Sagas

A saga is a business transaction spread across several services, built from a sequence of local transactions. Each step commits in its own database and emits a message that triggers the next step. There is no global rollback. If a later step fails, the saga runs compensating transactions that semantically undo the earlier steps. microservices.io describes it as "a reliably coordinated sequence of local transactions".

### The booking example

Imagine the capstone grows a payment service. Booking a paid seat is then:

1. **Booking service**: reserve the seat, booking status `PENDING`. Compensation: release the seat, status `CANCELLED`.
2. **Payment service**: charge the card. Compensation: refund.
3. **Booking service**: confirm, status `CONFIRMED`.
4. **Notification worker**: send the confirmation email. No compensation; it is the last step and it is retried until it succeeds.

If payment is declined, step 1's compensation releases the seat. Notice the shape: steps that can fail for business reasons go early; steps that cannot be undone (sending email) go last, after the point of no return. Some steps, like a refund, must eventually succeed, so they are retried rather than compensated.

### Why compensations are not rollbacks

A rollback makes it as if nothing happened. A compensation is a new, visible action. Between the reservation and the release, other users saw that seat as taken. Sagas are ACD without the I: there is no isolation between concurrent sagas. Mitigations, called countermeasures, include:

- **Semantic locks**: the `PENDING` status itself is a lock; other bookings treat the seat as unavailable, and a sweeper expires holds after N minutes.
- **Commutative updates**: design steps so their order does not matter.
- **Re-reading values**: check that the state you depend on has not changed before committing a later step.

### Choreography: services react to events

No one is in charge. Each service subscribes to the events it cares about and publishes its own:

- Booking publishes `booking.requested`.
- Payment consumes it, charges, publishes `payment.captured` or `payment.failed`.
- Booking consumes `payment.captured` → confirms, publishes `booking.confirmed`. It consumes `payment.failed` → releases the seat, publishes `booking.cancelled`.
- Notification consumes `booking.confirmed` and `booking.cancelled`.

Every publish goes through that service's outbox; every consumer is idempotent. This is what you already have in the capstone with one hop. It is simple at two or three steps. At six, the flow exists only as the sum of subscriptions spread across repositories, and answering "where is booking 42 stuck?" means correlating logs from every service.

### Orchestration: a coordinator tells services what to do

A saga orchestrator holds the state machine for each saga instance. It sends commands (`CapturePayment`) and waits for replies (`PaymentCaptured`, `PaymentFailed`). On failure, it issues the compensating commands in reverse order. Its own state lives in a database, so it survives restarts, and it uses the outbox to send commands reliably.

```python
class BookingSagaState(StrEnum):
    SEAT_RESERVED = "seat_reserved"
    PAYMENT_REQUESTED = "payment_requested"
    CONFIRMED = "confirmed"
    COMPENSATING = "compensating"
    CANCELLED = "cancelled"

async def on_reply(session: AsyncSession, saga: BookingSaga, reply: Envelope) -> None:
    match (saga.state, reply.type):
        case (BookingSagaState.PAYMENT_REQUESTED, "payment.captured"):
            saga.state = BookingSagaState.CONFIRMED
            await emit(session, "booking.confirm", saga)          # via outbox
        case (BookingSagaState.PAYMENT_REQUESTED, "payment.failed"):
            saga.state = BookingSagaState.COMPENSATING
            await emit(session, "seat.release", saga)             # compensation
        case _:
            log.info("ignored out-of-order or duplicate reply", saga=saga.id, type=reply.type)
```

### This is what Camunda does

A BPMN process in Camunda is a saga orchestrator with a visual state machine. Service tasks are the steps. A compensation boundary event attached to a task links it to its undo task. A compensation throw event (often inside an error event subprocess) runs the undo tasks for every completed step, in reverse. Bernd Rücker's trip-booking example on GitHub models car, hotel and flight reservations exactly this way, with a cancel task attached to each. When you model a process with Kafka-connected workers at BI Group, you are writing an orchestrated saga; the engine stores saga state, handles timers ("cancel the hold after 15 minutes") and gives you Cockpit/Operate to see where each instance is stuck.

&#91;embedded content: saga styles · booking, payment, notification\]

In choreography the flow is the sum of subscriptions; in orchestration it is one state machine you can read and monitor.

### Choreography vs orchestration

|  | Choreography | Orchestration |
| --- | --- | --- |
| Control | Distributed in subscriptions | Central state machine |
| Coupling | Services know event types, not each other | Orchestrator knows every participant's commands |
| Visibility | Hard; reconstruct from logs and traces | Easy; one place shows each saga's state |
| Adding a step | Change one or more subscribers; risk of cycles | Change the orchestrator's flow |
| Timeouts and compensations | Spread across services | In one place; BPMN engines model them natively |
| Single point of failure | None | Orchestrator (mitigated by persistence and replicas) |
| Best for | 2–4 steps, stable flows, loosely related teams | Many steps, branching, timers, human tasks, audit needs |

### Pitfalls

- Compensations that can fail permanently. A refund that cannot be retried leaves the saga stuck. Make compensations idempotent and retryable.
- Irreversible steps early in the saga. Send the email after the last step that can fail.
- Forgetting timeouts. A saga waiting for a reply that never comes holds the seat forever. Every wait needs a deadline.
- Choreography loops: service A reacts to B, which reacts to A. Draw the event graph before adding a subscription.

## 8. Operational concerns

The patterns above only hold if the worker behaves well when it is deployed, scaled, overloaded or fed garbage. Four habits cover most of it.

### Graceful shutdown

Docker Compose and Kubernetes stop a container by sending `SIGTERM`, waiting a grace period (10 s for Compose, 30 s for Kubernetes by default), then sending `SIGKILL`. In that window the worker should: stop fetching, finish the message in hand, commit its offset, and call `consumer.close()`. `close()` leaves the group cleanly, so the broker reassigns partitions immediately instead of waiting for the session timeout.

```python
import signal
from confluent_kafka import Consumer, KafkaException

class Worker:
    def __init__(self, consumer: Consumer, handler: Handler) -> None:
        self._consumer = consumer
        self._handler = handler
        self._running = True

    def stop(self, *_: object) -> None:
        self._running = False          # only flip a flag; never do work in a signal handler

    def run(self) -> None:
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        try:
            while self._running:
                msg = self._consumer.poll(1.0)     # short timeout so the flag is checked often
                if msg is None:
                    continue
                if msg.error():
                    raise KafkaException(msg.error())
                self._handler.handle(msg)          # idempotent; routes failures to retry/DLT
                self._consumer.commit(message=msg, asynchronous=False)
        finally:
            self._consumer.close()                 # leave the group, release partitions
```

With `enable.auto.commit=False`, the explicit commit after each handled message is what makes this at-least-once. Committing per message is slow at high volume; commit every N messages or every second instead, and make sure the final commit happens in `finally` before `close()` (with auto-commit off, `close()` does not commit for you). If the handler is async, run the poll loop in a thread or use `asyncio.to_thread(consumer.poll, 1.0)`, and register the handler with `loop.add_signal_handler`.

The Kafka-core notes cover rebalance callbacks (`on_revoke`); commit there too if you batch commits, otherwise a rebalance replays everything since the last commit.

### Consumer lag

Lag is, per partition, the log end offset minus the group's committed offset. It is the single best health signal for a worker: rising lag means you are falling behind or stuck; flat non-zero lag on one partition usually means a poison message or a blocked retry.

- Quick look: `kafka-consumer-groups.sh --bootstrap-server kafka:9092 --describe --group notification-worker` prints CURRENT-OFFSET, LOG-END-OFFSET and LAG per partition.
- In production: an exporter (such as kafka-exporter or Burrow) feeding Prometheus, with alerts on lag growing for 5+ minutes rather than on a fixed number.
- In code: `consumer.get_watermark_offsets(tp)` returns `(low, high)`; compare `high` with `consumer.committed([tp])` to log lag yourself.

Alert on lag of the retry topics and inflow to the DLT too, not only the main topic.

### Poison-pill safety

A poison pill crashes the worker on every attempt, so the container restarts, re-reads the same uncommitted message and crashes again. To make that impossible:

- Deserialize inside the try block. A `JSONDecodeError` or Pydantic `ValidationError` is a permanent error routed to the DLT, never an uncaught exception.
- Catch everything around the handler. Unknown exceptions go through the retry ladder and end in the DLT; the loop survives.
- Only let infrastructure failures (cannot reach Kafka, cannot produce to the DLT) crash the process. Then the message is not committed and will be retried after restart, which is what you want.

### Correlation IDs through headers

One user action now spans an HTTP request, a database transaction, an outbox row, a relay publish, maybe two retry hops and a worker. To follow it, carry one id through all of them:

1. FastAPI middleware reads `X-Correlation-ID` from the request or generates one, and stores it in a `contextvars.ContextVar`.
2. The booking handler writes it into the outbox row's `headers` column.
3. The relay copies it into Kafka headers.
4. The worker reads it from the headers, sets the context var, and every log line includes it. Retry and DLT republishing keep it (that is why `route_failure` keeps non-`x-` headers).

```python
correlation_id: ContextVar[str | None] = ContextVar("correlation_id", default=None)

def header(msg: Message, name: str) -> str | None:
    for k, v in msg.headers() or []:
        if k == name and v is not None:
            return v.decode()
    return None

# in the worker, before handling
correlation_id.set(header(msg, "correlation_id") or str(uuid4()))
```

If you adopt OpenTelemetry later, the W3C `traceparent` header plays the same role and gives you a trace view across services; propagate it the same way.

### Pitfalls

- Doing work in the signal handler, or calling `sys.exit()` mid-message. Set a flag and let the loop finish.
- A `poll()` timeout of 30 s. Shutdown then waits up to 30 s before even noticing the flag, and Compose kills the process at 10 s.
- Handler time exceeding `max.poll.interval.ms`, causing the broker to evict the consumer mid-processing.
- Logging the whole payload at INFO. Payloads hold personal data; log ids and types.

## Apply it to the capstone

This week you replace the direct Kafka call in the booking endpoint with an outbox, add a relay, give the worker a retry/DLT path, and make it shut down cleanly. Work in this order; each step is testable on its own.

### Task 1: outbox table + same-transaction write

- [ ] Alembic migration: `outbox` (section 2 schema) and `processed_messages` (section 3). Add the partial index on unpublished rows.
- [ ] In the booking service function, insert the outbox row inside the same `async with session.begin()` block as the seat lock and booking insert. Remove every `producer` reference from the API process.
- [ ] Build the envelope at write time: generate `event_id` here, set `occurred_at`, copy the correlation id from the request context.

Hints:

- Keep the outbox insert in a small helper, `add_event(session, aggregate_id, type, payload)`, so future events (`booking.cancelled`) cannot forget it.
- The no-overselling guarantee still comes from `SELECT ... FOR UPDATE` on the seat or a unique constraint on `(show_id, seat_id)` among active bookings. The outbox does not change that; it just rides along in the transaction.

### Task 2: the relay process

- [ ] New entrypoint `python -m app.relay`, its own service in `docker-compose.yml`, depending on Postgres and Kafka health checks.
- [ ] Loop: claim batch with `FOR UPDATE SKIP LOCKED` → produce with key = `aggregate_id` and `event_id` header → `flush` with timeout → mark `published_at` → commit. Sleep when empty.
- [ ] Producer config: `enable.idempotence: True`, `acks: "all"`.
- [ ] Handle `SIGTERM` the same way as the worker: finish the current batch, then exit.

A skeleton to fill in:

```python
async def run_relay(sessionmaker: async_sessionmaker[AsyncSession], producer: Producer, stop: asyncio.Event) -> None:
    while not stop.is_set():
        async with sessionmaker() as session:
            published = await relay_once(session, producer, topic_for=...)  # section 2
        if published == 0:
            try:
                await asyncio.wait_for(stop.wait(), timeout=0.5)
            except TimeoutError:
                pass
```

Decide and document: one relay replica (simplest ordering) or several with sharding. For the capstone, one replica plus `SKIP LOCKED` as a safety net is enough.

### Task 3: retry topic and dead-letter topic

- [ ] Create topics at startup with the AdminClient (`NewTopic`): `booking.created`, `booking.created.retry` (one delay level is fine to start, e.g. 30 s), `booking.created.dlt`. Set DLT `retention.ms` to 30 days.
- [ ] In the worker, wrap handling: permanent error → DLT; transient → retry topic with `x-attempt` and `x-retry-not-before`; attempt > 3 → DLT. Produce and flush BEFORE committing the original offset.
- [ ] A retry consumer (can be the same process, separate consumer group `notification-worker-retry`) that waits until `x-retry-not-before` using `pause`/`seek`/`resume`, then calls the same handler.
- [ ] A tiny `replay_dlt.py` CLI: read the DLT from the beginning (fresh group id), strip `x-` headers, produce to the original topic.

Hint: make the worker's handler a pure function of the envelope plus a DB session. Then the main consumer, the retry consumer and replay all share it, and tests can call it directly.

### Task 4: graceful worker shutdown

- [ ] `enable.auto.commit: False`; commit after the handler's DB transaction commits.
- [ ] Signal handler that only sets a flag; `poll(1.0)`; `close()` in `finally`.
- [ ] Compose: `stop_grace_period: 30s` on the worker if a message can take longer than 10 s.
- [ ] Manual check: `docker compose stop worker` while it handles a slow message (add a debug sleep). Logs should show "finished", "committed", "closed", and no reprocessing on restart.

### Tests

Use testcontainers: `from testcontainers.kafka import KafkaContainer` with `KafkaContainer().with_kraft()` and `get_bootstrap_server()`, plus a Postgres container. Session-scoped fixtures keep the suite fast.

**Test 1: a booking is consumed exactly once.** "Exactly once" here means exactly one side effect, not one delivery.

```python
async def test_booking_notifies_once(api_client, run_relay_once, run_worker_until_idle, db) -> None:
    resp = await api_client.post("/bookings", json={"show_id": SHOW, "seat_id": SEAT})
    assert resp.status_code == 201
    await run_relay_once()
    await run_relay_once(force_republish=True)   # simulate a relay crash: same rows sent twice
    await run_worker_until_idle()
    rows = await db.scalars(select(Notification).where(Notification.booking_id == resp.json()["id"]))
    assert len(rows.all()) == 1
```

Ideas for `force_republish`: reset `published_at` to NULL for the row and run the relay again. Assert also that `processed_messages` has one row for that `event_id`.

**Test 2: a rolled-back booking leaves nothing behind.**

- Book seat X successfully, then book seat X again: the second request must fail (409) and add no outbox row. Assert `count(outbox) == 1`.
- Force a failure after the outbox insert but before commit (monkeypatch a function called last in the transaction to raise). Assert zero bookings and zero outbox rows, run the relay, and assert a consumer on `booking.created` receives nothing within a short timeout (e.g. 3 s).

**Worth adding:** a poison message produced directly to `booking.created` lands in the DLT with `x-exception-class` set, and the next valid message is still processed.

### Definition of done

- No code path in the API process imports `confluent_kafka`.
- Killing the relay or the worker at any moment loses nothing and duplicates no side effect.
- One malformed message cannot stop the worker.
- Every log line for a booking can be found by its correlation id.

## Check yourself

Answer out loud, as in an interview, before reading the answers.

1. Your booking endpoint commits to Postgres, then produces to Kafka. Describe two distinct failure timelines and what each one breaks for the user.
2. Why can't Kafka transactions or exactly-once semantics solve the dual-write problem on their own?
3. Walk through the transactional outbox end to end. Where can a duplicate appear, and who is responsible for handling it?
4. What does `FOR UPDATE SKIP LOCKED` do in the relay query, and what ordering problem appears if you run three relay replicas?
5. Compare a polling outbox relay with Debezium CDC. When would you switch?
6. Your consumer inserts into `processed_messages`, commits, then sends an email. What goes wrong, and how do you fix it?
7. Why is in-place retry with a 5-minute backoff a bad idea for a Kafka consumer? Name two concrete consequences.
8. Design a retry and DLT topology for `booking.created`. What headers do you add, and in what order do you produce and commit?
9. What ordering guarantee do you lose with retry topics, and how could you keep per-key order if you had to?
10. When would you use a compacted topic, and what is a tombstone? Why should `booking.created` not be compacted?
11. Explain the saga pattern with a booking → payment → notification flow. Choreography or orchestration, and why?
12. How does a consumer shut down gracefully, and what happens if it does not call `close()`?

For more practice, the interview roadmap's Microservices notes cover the same ground: Q25 (saga pattern), Q42 (transaction management in microservices), Q44–45 (orchestration and choreography), Q57 (retries) and Q58 (dead letter queues), in [SDE-Interview-and-Prep-Roadmap: Microservices.md](https://github.com/aasthas2022/SDE-Interview-and-Prep-Roadmap/blob/main/System%20Design/Microservices.md). Q43 in that list is about service registries, which is off-topic for this week.

## Answers

1. **Commit then produce:** the process dies or Kafka is down after commit; the booking exists but no event, so no confirmation and downstream services never learn of it. **Produce then commit:** the event is sent, then the commit fails (seat taken, connection lost); consumers act on a booking that does not exist. A third case: an ambiguous timeout where you cannot tell whether the produce landed.
2. Kafka transactions make writes across Kafka partitions (and consumer offsets) atomic. Postgres is not a participant, and Kafka does not support XA. So the database commit and the Kafka write still cannot be atomic together.
3. The handler writes the business rows and an outbox row in one transaction. A relay claims unpublished rows, produces them keyed by aggregate id, waits for acks, marks them published. If it crashes after the acks but before marking, the batch is sent again. Consumers handle that by deduping on `event_id`.
4. It locks the selected rows for the relay's transaction and makes other relays skip locked rows instead of blocking, so replicas do not publish the same rows concurrently. With three replicas, two events for one aggregate can be claimed by different relays and published out of order. Fix: one active relay (advisory lock) or shard by aggregate id.
5. Polling: simple, one process, SQL-debuggable, adds query load and poll latency. CDC: reads the WAL, near-real-time, follows commit order, no polling load, but needs Kafka Connect and replication-slot care. Switch when outbox volume or latency needs outgrow polling, or when the platform already runs Connect.
6. If the process crashes after the commit and before the email, the event is marked processed and the email is never sent. Fix: in one transaction, insert the dedupe row and a `notifications` row with status `pending`; send afterwards and mark `sent`; pass an idempotency key to the email provider.
7. The partition is blocked, so all messages behind it wait. And the poll loop exceeds `max.poll.interval.ms` (5 min default), so the broker evicts the consumer, rebalances, and another consumer reprocesses the same message, possibly in a loop.
8. Main → `booking.created.retry.10s` → `booking.created.retry.1m` → `booking.created.dlt`; permanent errors go straight to the DLT. Headers: original topic/partition/offset, attempt count, exception class and message, failed-at, retry-not-before; keep `event_id` and `correlation_id`. Produce to the retry/DLT topic, confirm delivery, then commit the original offset.
9. Per-key order: a later event for the same key can be processed on the main topic while an earlier one waits in retry. To keep order, block in place for that key's partition, or track keys in the retry path and divert later events for those keys behind them until the earlier one succeeds.
10. For state where only the latest value per key matters: changelogs, reference data, caches rebuilt by replay. A tombstone is a record with a key and a null value that deletes the key after `delete.retention.ms`. `booking.created` is a stream of facts; compaction could drop events consumers still need.
11. Reserve seat (compensate: release) → capture payment (compensate: refund) → confirm booking → send notification (last, irreversible). Choreography fits a short, stable flow like this. Choose orchestration (e.g. a Camunda BPMN process) once there are timeouts, branches, many steps, or a need to see each instance's state.
12. On SIGTERM, set a flag, finish the current message, commit its offset, call `close()`. Without `close()`, the group waits for the session timeout before reassigning the partitions, and any processed-but-uncommitted messages are reprocessed by the next owner.

## Sources

- [Pattern: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) — microservices.io
- [Pattern: Saga](https://microservices.io/patterns/data/saga.html) — microservices.io
- [Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html) — Debezium documentation
- [Reliable Microservices Data Exchange With the Outbox Pattern](https://debezium.io/blog/2019/02/19/reliable-microservices-data-exchange-with-the-outbox-pattern/) — Debezium blog
- [Error Handling Patterns in Kafka](https://www.confluent.io/blog/error-handling-patterns-in-kafka/) — Confluent blog
- [Topic configs (Kafka 4.3)](https://kafka.apache.org/43/generated/topic_config.html) — Apache Kafka: `cleanup.policy`, `retention.ms`, `delete.retention.ms`, compaction lags
- [Log Compaction](https://docs.confluent.io/kafka/design/log_compaction.html) — Confluent design docs
- [Schema Evolution and Compatibility](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html) — Confluent Schema Registry
- [Non-blocking retries: configuration](https://docs.spring.io/spring-kafka/reference/4.0/retrytopic/retry-config.html) — Spring for Apache Kafka (reference design for retry topics)
- [Python client overview](https://docs.confluent.io/kafka-clients/python/current/overview.html) — Confluent: manual commits, at-least-once, `close()`
- [confluent-kafka Python API reference](https://docs.confluent.io/platform/current/clients/confluent-kafka-python/html/index.html) — Confluent
- [Kafka module](https://testcontainers-python.readthedocs.io/en/testcontainers-v4.14.2/modules/kafka/README.html) — testcontainers-python
- [flowing-trip-booking-saga](https://github.com/berndruecker/flowing-trip-booking-saga) — Bernd Rücker, saga with Camunda BPMN compensation
- [Microservices.md](https://github.com/aasthas2022/SDE-Interview-and-Prep-Roadmap/blob/main/System%20Design/Microservices.md) — SDE Interview and Prep Roadmap
