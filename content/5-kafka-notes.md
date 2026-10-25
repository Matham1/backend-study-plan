# Study Notes — Week 5: Kafka Core

Oct 23, 2026 · @Mathew Matholomew

After this week you should be able to explain, from the log up, why Kafka delivers what it promises: per-partition ordering, durability through replication, and at-least-once by default with exactly-once only inside Kafka. You will also run a 3-broker KRaft cluster in Docker Compose, publish `booking.created` safely from the FastAPI service, and consume it from a notification worker that survives broker failures, crashes and duplicate deliveries. Production patterns (outbox, retries, dead-letter topics, sagas, compaction) live in the sibling doc; this one is the foundation they stand on.

## 1. The log: topics, partitions, offsets

Kafka is a distributed, append-only log. Everything else in this doc (ordering, replication, consumer groups, exactly-once) is a consequence of that one design choice.

**Topic and partition.** A topic is a name, like `booking.created`. Physically it is split into N partitions. Each partition is an ordered, immutable sequence of records that only grows at the end. A record has a key, a value, a timestamp and optional headers, all treated as bytes by the broker.

**Offset.** Each record in a partition gets a monotonically increasing 64-bit offset: 0, 1, 2, and so on. An offset is only meaningful inside one partition. `booking.created` partition 0 offset 42 and partition 1 offset 42 are unrelated records.

**Segments.** On disk a partition is a directory of segment files. Only the newest (active) segment receives appends. When it reaches `log.segment.bytes` (default 1 GiB) or `log.roll.ms`, the broker closes it and opens a new one. Each segment has an offset index and a time index, so seeking to an offset or timestamp is a binary search, not a scan. Writes are sequential appends and reads mostly hit the OS page cache, which is why Kafka is fast on ordinary disks.

**Retention.** Records are not deleted when someone reads them. The broker deletes whole closed segments when they age past `retention.ms` (broker default `log.retention.hours=168`, one week) or when the partition exceeds `retention.bytes` (default -1, unlimited). The alternative policy, log compaction, keeps the latest record per key and is covered in the sibling doc.

### Why Kafka is not a queue

In RabbitMQ or SQS the broker tracks each message's state and removes it once acknowledged. Kafka does the opposite. The broker keeps the data and does not care who read it. Each consumer group stores just one number per partition: the offset of the next record to read.

That inversion has practical consequences:

- **Replay.** Reset a group's offset to an earlier position and it re-reads history. You can rebuild a read model or fix a bug and reprocess last week.
- **Many independent readers.** The notification worker, an analytics job and an audit service can each read `booking.created` at their own pace. Adding a reader costs the producer nothing.
- **Cheap bookkeeping.** The broker does not track per-message acks, so state per group is tiny.
- **The cost.** You cannot skip one bad record and keep the rest of the partition flowing the way a queue does with per-message nack. Parallelism is capped by partition count. Share groups (KIP-932, early access in 4.0, generally available in 4.2) add queue-style consumption; this course uses classic consumer groups.

```text
booking.created  partition 0:  [0][1][2][3][4][5][6] <- producer appends here
                                         ^
                       group "notifier" committed offset = 4
                       (records 0..3 done, 4 is next)
```

**Read more:** *Kafka: The Definitive Guide*, ch. 6 (physical storage, segments, indexes); Confluent Kafka 101, lessons on Topics and Partitions.

**Pitfalls**

- Treating offsets as global. There is no topic-wide order or offset, only per-partition ones.
- Assuming retention guarantees reprocessing. If a consumer is down longer than `retention.ms`, its committed offset points at deleted data and `auto.offset.reset` decides where it restarts.
- Relying on `auto.create.topics.enable` (default true). Auto-created topics get broker defaults: one partition and replication factor 1. Create topics explicitly.
- Retention is per segment. A record can live longer than `retention.ms` while its segment is still active.

## 2. Producers in depth

A producer turns `produce()` calls into batched, compressed, retried network requests to partition leaders. Its settings decide three things: which partition a record lands in, how much latency you trade for throughput, and what "sent" actually means.

**Important for Python.** confluent-kafka wraps librdkafka (C), not the Java client. Several defaults differ from the Java docs and from *The Definitive Guide*. Where they differ, both are given below.

### Keys and the partitioner

The partitioner picks a partition per record:

- **Key present:** hash(key) mod partition\_count. Same key, same partition, as long as the partition count does not change. This is the basis of ordering (section 7).
- **Key null:** no hash. Java (since 3.3, KIP-794) uses a *uniform sticky* partitioner: it keeps sending to one partition until about `batch.size` bytes have gone there, then switches, weighted toward less-loaded brokers. Sticking fills batches faster than round-robin.

The hash function is the trap. Java uses murmur2. librdkafka's default `partitioner` is `consistent_random`, a CRC32 hash. The same key can land on different partitions depending on which language produced it. If anything else (a NestJS service with KafkaJS, a Java tool) also produces to the topic, set `partitioner: murmur2_random` in Python to match Java. KafkaJS's default partitioner is also murmur2-based.

### Batching and compression

Records are buffered per partition into batches. A batch is sent when it is full or when it has waited `linger.ms`.

| Setting | Java default | librdkafka default | Effect |
| --- | --- | --- | --- |
| `linger.ms` | 5 (changed from 0 in 4.0) | 5 | Wait time to fill a batch. Higher = bigger batches, more latency. |
| `batch.size` | 16384 bytes | 1,000,000 bytes | Max batch bytes per partition. |
| `compression.type` | none | none | `lz4` or `zstd` compress whole batches. Bigger batches compress better. |
| `acks` | all | all (-1) | See table below. |
| `enable.idempotence` | true (since 3.0) | **false** | Dedupe retries at the broker. |
| `delivery.timeout.ms` | 120000 | 300000 (alias of `message.timeout.ms`) | Total time budget for a record, retries included. |
| `retries` | 2147483647 | 2147483647 | Effectively bounded by the delivery timeout. |

Compression happens on the producer, the broker stores the compressed batch as is (if the topic's `compression.type` is `producer`), and consumers decompress. CPU moves to the edges and network and disk shrink.

### acks: what "sent" means

| `acks` | Leader replies when | Lost on leader crash? | Latency | Use for |
| --- | --- | --- | --- | --- |
| `0` | Never; fire and forget | Yes, silently | Lowest | Metrics you can lose |
| `1` | Leader wrote it to its log | Yes, if followers had not copied it yet | Low | Logs, low-value events |
| `all` (-1) | All current in-sync replicas have it | No, if `min.insync.replicas` >= 2 | Highest | Bookings, payments |

`acks=all` alone is weaker than it sounds. If the ISR shrinks to just the leader, "all" means one copy. Section 5 pairs it with `min.insync.replicas`.

### Retries, timeouts and idempotence

Transient errors (leader moved, broker restarting, `NOT_ENOUGH_REPLICAS`) are retried automatically until `delivery.timeout.ms` expires. Then the delivery callback gets an error and the record is gone from the producer. Your code must handle that callback.

Retries create a duplicate risk. The broker writes batch A but the ack is lost. The producer retries and A is written twice. The **idempotent producer** fixes this:

1. On startup the producer gets a **producer ID (PID)** and epoch from the cluster.
2. Every batch carries the PID and a **sequence number** per partition.
3. The partition leader remembers the last sequence numbers for each PID (the last five batches). A retry with an already-seen sequence is acknowledged but not written again. A gap in sequence is rejected as out of order.

The guarantee is *per producer session, per partition*: no duplicates from retries, and no reordering. It does not survive a producer restart (new PID), and it does nothing if your application calls `produce()` twice for the same booking. That is an application-level duplicate.

### max.in.flight and ordering

`max.in.flight.requests.per.connection` is how many unacknowledged requests may be outstanding per broker. With several in flight and no idempotence, batch 1 can fail, batch 2 can succeed, and the retry of batch 1 lands after it: reordered. With idempotence on, the broker rejects batch 2 until batch 1's sequence arrives, so ordering holds with up to **5** in flight. librdkafka enforces this: enabling idempotence sets `max.in.flight` to 5, `acks=all` and unlimited retries, and refuses incompatible values.

```python
from confluent_kafka import Producer

PRODUCER_CONF: dict[str, str | int | bool] = {
    "bootstrap.servers": "kafka-1:19092,kafka-2:19092,kafka-3:19092",
    "client.id": "booking-api",
    "enable.idempotence": True,      # off by default in librdkafka
    "acks": "all",                    # implied by idempotence; explicit for readers
    "linger.ms": 10,
    "compression.type": "lz4",
    "delivery.timeout.ms": 30_000,    # fail fast enough to surface in API logs
    "partitioner": "murmur2_random",  # same key->partition mapping as Java/KafkaJS
}
producer = Producer(PRODUCER_CONF)
```

**Read more:** *Definitive Guide* ch. 3 (Producers) and ch. 8 (idempotent producer section); KIP-794 for the sticky partitioner.

**Pitfalls**

- Copying Java defaults into Python. In confluent-kafka idempotence is off unless you set it.
- Mixed-language producers with different hash functions silently break per-key ordering.
- Treating `produce()` as "sent". It only enqueues. Success or failure arrives later in the delivery callback.
- Setting `delivery.timeout.ms` lower than `linger.ms + request.timeout.ms`. The Java client rejects it; in any client it means records time out before a real attempt.
- Expecting idempotence to dedupe two separate `produce()` calls. It only dedupes the producer's own retries.

## 3. Consumers and consumer groups

A consumer group is a set of processes sharing one `group.id` that split a topic's partitions between them. Each partition is read by exactly one member of the group at a time. That one rule gives you both load balancing and per-partition ordering.

### Assignment

One broker acts as the **group coordinator** for the group (chosen by hashing `group.id` onto a partition of the internal `__consumer_offsets` topic). Members join, the partitions are divided, and each member fetches only its own partitions.

- 6 partitions, 2 workers: 3 each.
- 6 partitions, 6 workers: 1 each.
- 6 partitions, 8 workers: 2 workers sit idle. Partition count is the ceiling on parallelism within a group.

A different `group.id` is a separate, independent reader with its own offsets. That is how the notifier and an analytics job both see every booking.

&#91;embedded content: partitions and consumer groups · 6 partitions, 2 groups\]

The analytics group gets every record through one consumer; the notifier group splits the same records between two workers, three partitions each.

### Rebalances

A rebalance reassigns partitions. It happens when a member joins, leaves, crashes, or is considered dead, and when partitions are added to a subscribed topic.

- **Eager** (classic range and round-robin assignors): every member gives up all its partitions, then gets a new set. Consumption stops for the whole group during the rebalance.
- **Cooperative incremental** (`cooperative-sticky`): members keep the partitions that are not moving and only revoke the ones that are. Usually two short rounds, and most consumption continues.

Defaults differ again. Java's `partition.assignment.strategy` is `[RangeAssignor, CooperativeStickyAssignor]`. librdkafka's is `range,roundrobin`, which is eager. In Python set `"partition.assignment.strategy": "cooperative-sticky"` explicitly. All members of a group must agree on a compatible strategy.

### Liveness: three timers

| Setting | Default (classic) | What it detects |
| --- | --- | --- |
| `heartbeat.interval.ms` | 3000 | How often a background thread tells the coordinator "I am alive". |
| `session.timeout.ms` | 45000 | No heartbeat for this long = process dead or network partitioned. Member is removed. |
| `max.poll.interval.ms` | 300000 | Heartbeats are fine but the app has not called `poll()` for this long = processing is stuck. Member leaves the group. |

The split matters. Heartbeats come from a background thread, so a worker that hangs inside your handler keeps heartbeating. `max.poll.interval.ms` is what catches it. If one email send can block for minutes, either lower the batch size or bound the handler with a timeout.

### Static membership

By default every restart is a leave plus a join, so two rebalances per deploy. With `group.instance.id` set to a stable name per replica (`notifier-1`), a restarted member that returns within `session.timeout.ms` gets its old partitions back with no rebalance. Useful for rolling deploys in Kubernetes. The cost: a truly dead static member is only detected after the full session timeout.

### The new consumer group protocol (KIP-848)

The classic protocol puts assignment on the client: one member is elected leader, computes the plan and sends it back through the coordinator. Every member must sync, which is the "stop-the-world" barrier.

KIP-848 moves assignment to the broker. Each member sends heartbeats carrying its subscription, the coordinator computes the target assignment with a server-side assignor (`uniform` or `range`), and each member converges toward it incrementally. There is no global barrier.

Status as of October 2026:

- Generally available since Kafka 4.0. Enabled on brokers by default; clients opt in with `group.protocol=consumer`.
- Java consumers plan to default to it in 5.0. confluent-kafka-python marked it production-ready in 2.12.0 but still defaults to `classic`.
- With `consumer`, the client settings `session.timeout.ms`, `heartbeat.interval.ms` and `partition.assignment.strategy` no longer apply. The broker's `group.consumer.*` settings and the client's `group.remote.assignor` replace them.

For the capstone, start with `classic` + `cooperative-sticky` so the timers above behave as described in the book. Trying `group.protocol=consumer` afterwards is a good stretch exercise.

```python
CONSUMER_CONF: dict[str, str | int | bool] = {
    "bootstrap.servers": "kafka-1:19092,kafka-2:19092,kafka-3:19092",
    "group.id": "notifier",
    "client.id": "notifier-1",
    "group.instance.id": "notifier-1",          # static membership, optional
    "partition.assignment.strategy": "cooperative-sticky",
    "enable.auto.commit": False,                 # section 4
    "auto.offset.reset": "earliest",            # new group starts at the beginning
    "max.poll.interval.ms": 120_000,
}
```

**Read more:** *Definitive Guide* ch. 4 (consumer groups, rebalances, static membership); Kafka docs, "Consumer Rebalance Protocol" page; Confluent Kafka Internals course, consumer group protocol lesson.

**Pitfalls**

- More consumers than partitions. The extras do nothing.
- Slow handlers silently exceeding `max.poll.interval.ms`. The worker gets kicked, its partitions move, and uncommitted work is redelivered to someone else. Then it happens again.
- Mixing eager and cooperative assignors in one group without a two-step migration.
- Forgetting `close()` on shutdown. The group waits a full session timeout before reassigning the partitions.
- `auto.offset.reset` defaults to `latest`. A brand-new group skips everything already in the topic.

## 4. Offsets and delivery semantics

Your delivery guarantee is decided by one thing: whether you commit an offset before or after the side effect. Kafka's default setup gives you neither guarantee cleanly; you have to choose.

**What a commit is.** A commit writes `(group, topic, partition) -> offset` to the internal `__consumer_offsets` topic. The committed value is the offset of the *next* record to read, so after processing offset 41 you commit 42. In confluent-kafka, `commit(message=msg)` does the +1 for you. On restart or rebalance, whoever owns the partition resumes from the committed offset. Everything after it is re-read.

### Auto-commit

With `enable.auto.commit=true` (the default) the client commits periodically (`auto.commit.interval.ms`, default 5000) in the background. In librdkafka it commits the offsets *stored* for records already handed to your app by `poll()` (`enable.auto.offset.store=true`). Handed over is not processed. If the worker crashes after the auto-commit but before the email goes out, that booking is lost. If it crashes after sending but before the next auto-commit, the email repeats. You get neither at-least-once nor at-most-once.

### Manual commit strategies

| Strategy | Order of operations | Crash between the two steps | Semantics |
| --- | --- | --- | --- |
| Auto-commit, defaults | Background timer, unrelated to processing | Loss or duplicates | None guaranteed |
| Commit before processing | `commit()` then `send_email()` | Record skipped | At-most-once |
| Commit after processing | `send_email()` then `commit()` | Record redelivered | At-least-once |
| Auto-commit + `enable.auto.offset.store=false` + `store_offsets(msg)` after processing | Process, mark as done, background commits marked offsets | Record redelivered | At-least-once, fewer commit round-trips |
| Commit after + idempotent handler | Dedupe by booking ID, then commit | Redelivered, then ignored | Effectively exactly-once *effects* |

At-least-once is the right default for notifications. A duplicate email is annoying; a missing confirmation is a support ticket. Then make the handler idempotent so the duplicate never reaches the user (capstone section).

### Sync vs async commits

- `commit(asynchronous=False)` blocks until the coordinator confirms and raises `KafkaException` on failure. Simple and safe; costs one round-trip.
- `commit(asynchronous=True)` returns immediately. Failures surface in the `on_commit` callback. Faster, but you may not notice a failed commit.
- Common pattern: commit every N records or every few seconds asynchronously, and synchronously in the revoke callback and on shutdown.

### Why exactly-once end-to-end is hard

The crash window between "side effect done" and "offset committed" cannot be closed by Kafka alone, because the side effect is outside Kafka. There are only two ways out:

1. **Idempotent processing.** Make repeating the side effect harmless: a unique constraint on `booking_id` in a `processed_messages` table, an upsert, an idempotency key on the email API.
2. **Transactions.** If the output is another Kafka topic, write the output and the consumed offsets in one Kafka transaction (section 6). This works only when every effect lands in Kafka.

### Consumer lag

Lag per partition = log end offset minus committed offset. It is the number one health metric for a worker: growing lag means it cannot keep up or is stuck.

```bash
docker exec kafka-1 /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server kafka-1:19092 --describe --group notifier
# columns: TOPIC PARTITION CURRENT-OFFSET LOG-END-OFFSET LAG CONSUMER-ID HOST CLIENT-ID
```

**Read more:** *Definitive Guide* ch. 4 (commits and offsets) and ch. 7 (using consumers in a reliable system); Kafka docs, design section on message delivery semantics.

**Pitfalls**

- Committing `msg.offset()` yourself via `TopicPartition` without +1. You re-read the last record forever after each restart.
- Leaving auto-commit on and calling `commit()` too. You now have two commit paths racing.
- Committing offsets for partitions you no longer own after a rebalance. Commit in `on_revoke`, not later.
- Reading lag only in aggregate. One stuck partition hides inside a healthy total.

## 5. Brokers and replication

Durability in Kafka comes from copying each partition to several brokers and only calling a record committed once enough copies exist. The knobs are `replication.factor`, `min.insync.replicas` and `acks`, and they only work together.

### Leaders, followers and the ISR

Each partition has `replication.factor` replicas on different brokers. One is the **leader**: all produce requests, and by default all fetches, go to it. The others are **followers** that continuously fetch from the leader, exactly like a consumer would.

The **in-sync replica set (ISR)** is the leader plus the followers that are caught up. A follower that has not fully caught up for `replica.lag.time.max.ms` (default 30 s) is dropped from the ISR. It rejoins once it catches up.

The **high watermark** is the highest offset that every ISR member has. Records below it are *committed*. Consumers only see committed records, so a consumer never reads something that a leader failover could erase.

&#91;embedded content: replication and the ISR · one partition on 3 brokers\]

Broker 3 still holds a copy, but it is out of the ISR, so the leader no longer waits for it. The high watermark is set by the slowest ISR member, broker 2.

### min.insync.replicas + acks=all

With `acks=all` the leader waits for every *current* ISR member. If the ISR has shrunk to one, that is one copy. `min.insync.replicas` sets a floor: if the ISR is smaller than this value, the leader rejects `acks=all` writes with `NOT_ENOUGH_REPLICAS` instead of accepting a single-copy write.

The standard production setting is **replication.factor=3, min.insync.replicas=2, acks=all**:

- 3 brokers up: writes go to 3 copies.
- 1 broker down: ISR = 2 >= 2, writes continue, still 2 copies.
- 2 brokers down: ISR = 1 < 2, producers get errors. Reads of committed data still work. You lose availability for writes, never acknowledged data.

Broker defaults are `default.replication.factor=1` and `min.insync.replicas=1`, so set both per topic. Note that `min.insync.replicas` has no effect on `acks=0` or `acks=1` producers.

### When a broker dies

1. The controller notices the broker's session is gone (it stops heartbeating to the controller quorum).
2. For each partition led by that broker, the controller picks a new leader from the remaining ISR members and bumps the **leader epoch**.
3. It publishes the new metadata. Producers and consumers get `NOT_LEADER_OR_FOLLOWER` errors, refresh metadata, and reconnect to the new leader. With idempotence on, the producer's retries are deduplicated.
4. When the dead broker returns, it truncates any uncommitted tail of its log to match the new leader, catches up, and rejoins the ISR. Kafka later moves leadership back to the *preferred* replica (`auto.leader.rebalance.enable`).

### Unclean leader election

If every ISR member is gone and only an out-of-sync replica is alive, Kafka must choose. With `unclean.leader.election.enable=false` (default) the partition stays offline until an ISR member returns: consistent but unavailable. With `true` the stale replica becomes leader immediately and every committed record it never received is lost. Leave it off for bookings. Kafka 4.x also ships a preview of Eligible Leader Replicas (KIP-966), which tightens which replicas may be elected.

### KRaft: controllers instead of ZooKeeper

Cluster metadata (topics, partitions, leaders, ISRs, configs) used to live in ZooKeeper. In KRaft mode it lives in a Raft-replicated metadata log, `__cluster_metadata`, managed by a quorum of **controller** nodes. One controller is the active leader; brokers fetch the metadata log and apply it.

- Kafka 4.0 (March 2025) removed ZooKeeper support entirely. Every 4.x cluster runs KRaft.
- `process.roles` is `broker`, `controller` or `broker,controller` (combined). Combined mode is for development; production runs dedicated controllers.
- The quorum needs a majority alive: 3 controllers survive 1 failure, 5 survive 2.
- Every node's storage is formatted with the same cluster ID before first start. The `apache/kafka` image does this for you from `CLUSTER_ID`.

**Read more:** *Definitive Guide* ch. 6 (replication, controller, KRaft) and ch. 7 (broker configuration for reliability); Kafka docs, design section on replication and the KRaft operations page; Confluent Kafka Internals, data replication lesson.

**Pitfalls**

- `replication.factor=3` with `min.insync.replicas=1`. Writes are acknowledged with a single copy whenever the ISR shrinks.
- `min.insync.replicas` equal to `replication.factor`. One broker restart blocks all writes.
- Running 3 brokers but topics with RF 1, often via auto-creation. Killing a broker then makes those partitions unavailable.
- Forgetting internal topics. `__consumer_offsets` and `__transaction_state` need RF 3 too; on a local 3-broker cluster set `KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=3`.
- Turning on unclean leader election to "fix" an offline partition. You trade a short outage for permanent data loss.

## 6. Exactly-once semantics

Kafka's exactly-once semantics (EOS) means: within Kafka, a read-process-write step either fully happens or does not happen at all, even across crashes and retries. It does not mean an email is sent exactly once. Keep those two apart and EOS becomes easy to reason about.

### Two layers

| Layer | Config | Prevents | Scope |
| --- | --- | --- | --- |
| Idempotent producer | `enable.idempotence=true` | Duplicates and reordering from the producer's own retries | One producer session, one partition |
| Transactional producer | `transactional.id=<stable id>` (implies idempotence) | Partial writes across partitions; zombie instances; offsets committed without output, or output without offsets | Many partitions and topics, across restarts |
| Read-committed consumer | `isolation.level=read_committed` | Seeing records from aborted or still-open transactions | Downstream readers |

### How transactions work

1. **`init_transactions()`.** The producer finds its *transaction coordinator* (a broker chosen by hashing `transactional.id` onto the internal `__transaction_state` topic). The coordinator returns the PID and bumps an **epoch**. Any older producer with the same `transactional.id` and a lower epoch is now *fenced*: its writes are rejected. That is zombie protection, for example after a GC pause or a network split.
2. **`begin_transaction()`**, then normal `produce()` calls. Before writing to a new partition, the producer registers it with the coordinator.
3. **`send_offsets_to_transaction(offsets, group_metadata)`.** The consumer offsets you just processed are written as part of the same transaction, into `__consumer_offsets`.
4. **`commit_transaction()`.** The coordinator records "committing" in `__transaction_state`, then writes a commit marker (a control record) into every partition the transaction touched. Or `abort_transaction()` writes abort markers.

A `read_committed` consumer only reads up to the **last stable offset (LSO)**, the first offset of any still-open transaction, and skips records from aborted transactions. One slow transaction therefore delays readers of that partition.

```python
from confluent_kafka import Consumer, Producer, KafkaException, Message

def enrich(msg: Message) -> bytes: ...  # pure function, no side effects

def run_enricher(consumer: Consumer, producer: Producer) -> None:
    producer.init_transactions()
    consumer.subscribe(["booking.created"])
    while True:
        batch = consumer.consume(num_messages=100, timeout=1.0)
        records = [m for m in batch if m.error() is None]
        if not records:
            continue
        producer.begin_transaction()
        try:
            for m in records:
                producer.produce("booking.enriched", key=m.key(), value=enrich(m))
            producer.send_offsets_to_transaction(
                consumer.position(consumer.assignment()),
                consumer.consumer_group_metadata(),
            )
            producer.commit_transaction()
        except KafkaException as exc:
            if exc.args[0].txn_requires_abort():
                producer.abort_transaction()
                # rewind to the last committed offsets before retrying
            else:
                raise  # fatal, e.g. fenced: exit and let the supervisor restart
```

This is a sketch of the pattern, not code you need this week. The consumer here must have `enable.auto.commit=False` and `isolation.level=read_committed`.

### What EOS does not cover

- **External side effects.** Sending an email, calling a payment API or writing to PostgreSQL is not part of a Kafka transaction. If the worker sends the email and crashes before `commit_transaction()`, the transaction aborts and the email is sent again on retry. Kafka has no two-phase commit with outside systems.
- **The first write into Kafka.** The FastAPI handler writes the booking to PostgreSQL and then produces to Kafka: two systems, no shared transaction. That gap is what the outbox pattern in the sibling doc closes.
- **Consumers on `read_uncommitted`.** Java's default isolation is `read_uncommitted`; librdkafka's is `read_committed`. A Java or KafkaJS reader that leaves the default sees aborted records.

So for the notification worker the realistic target is at-least-once delivery plus an idempotent handler. Transactions are the tool for Kafka-to-Kafka pipelines, such as Kafka Streams with `processing.guarantee=exactly_once_v2`.

**Read more:** *Definitive Guide* ch. 8 (the whole chapter); Confluent Kafka Internals, transactions lesson; Kafka docs, design section on delivery semantics.

**Pitfalls**

- Reusing one `transactional.id` across replicas. They fence each other in a loop. Use a stable id per instance, e.g. `enricher-0`.
- Doing side effects inside the transaction and assuming abort undoes them.
- Long transactions. Readers using `read_committed` stall at the LSO, and `transaction.timeout.ms` (default 60 s) aborts them anyway.
- Treating `KafkaException` uniformly. Check `txn_requires_abort()` and `fatal()` on the `KafkaError` before deciding to abort or exit.

## 7. Ordering guarantees

Kafka guarantees order within a partition and nothing more. Records with the same key go to the same partition, so the practical rule is: *whatever must stay in order needs the same key*.

### What holds and what does not

- Two records in the same partition are read in the order they were appended. With idempotence on, the producer's retries cannot swap them.
- Two records in different partitions have no defined order. A consumer reading both may see them either way round.
- Within a group, one partition goes to one consumer, so a single process handles a key's records serially. That is the whole point of the one-partition-one-consumer rule.
- The guarantee ends at the consumer's handler. If your worker hands records to a thread pool, you reorder them yourself.

### Choosing the key for the capstone

Candidates for `booking.created`:

| Key | Ordering you get | Load spread | Verdict |
| --- | --- | --- | --- |
| `event_id` | All bookings for one concert in order (created, cancelled, seat released) | Uneven if one event is hot | Good default; matches the plan |
| `booking_id` | One booking's lifecycle in order | Very even | Fine if events never need cross-booking order |
| `user_id` | One user's actions in order | Even | Useful for per-user notification throttling |
| none | Nothing | Even (sticky batches) | Only for independent records |

Keying by `event_id` keeps "seat 12A booked" before "seat 12A released" for the same event, which a downstream seat-availability projection needs. The risk is a **hot partition**: a single popular concert sends all its traffic to one partition, which only one consumer can process. If that becomes real, you key by `booking_id` for notifications and keep `event_id` only on the topics that need event-level order.

### Partition count trade-offs

- **More partitions:** more consumer parallelism, more producer batching targets, higher total throughput.
- **Costs:** more open files and replication traffic per broker, more work during leader elections, more metadata, smaller batches per partition. KRaft raised the practical cluster-wide limit a lot, but a small team's topics rarely need more than tens.
- **Rule of thumb:** size for the peak number of consumers you expect in the group, with headroom. For the capstone, 6 partitions with 3 brokers is plenty.

### Adding partitions later breaks key mapping

You can increase a topic's partitions, never decrease. The partitioner computes hash(key) mod N. Change N from 6 to 8 and many keys move to a different partition. Existing records stay where they were. For a while, old records for event 42 sit in partition 3 while new ones go to partition 5, read by a different consumer, possibly before the old ones are done. Per-key order is broken across the change.

```python
import zlib

def crc32_partition(key: bytes, n: int) -> int:
    # librdkafka 'consistent' style; for illustration only
    return zlib.crc32(key) % n

for n in (6, 8):
    print(n, [crc32_partition(f"event-{i}".encode(), n) for i in range(1, 6)])
# the same keys land on different partitions once n changes
```

If you need more partitions on a keyed topic, the safe paths are: over-provision from the start, or create a new topic with the new count and migrate consumers after draining the old one.

**Read more:** *Definitive Guide* ch. 3 (partitions, "Implementing a custom partitioning strategy") and ch. 7 (ordering in reliable systems); Confluent Kafka 101, Partitions lesson.

**Pitfalls**

- Expecting topic-wide order. If you truly need it, you need one partition and one consumer, and you lose all parallelism.
- Processing a partition's records concurrently inside one worker and then committing the highest offset. A slower earlier record can still fail after its successor was committed.
- Low-cardinality keys such as `status` or `country`. A few partitions do all the work.
- Retrying a failed record by re-producing it to the same topic. It goes to the end of the partition, behind later records with the same key.

## 8. Python with confluent-kafka

confluent-kafka (2.16.0 at the time of writing) is a thin Python layer over librdkafka. librdkafka runs its own background threads for networking, batching and retries. Your Python code talks to it through queues, and that design explains every API rule below.

### Producer: produce, poll, flush

- `produce(topic, value=..., key=..., headers=..., on_delivery=cb)` appends to librdkafka's local queue and returns immediately. It raises `BufferError` if that queue is full.
- The delivery callback runs only when you call `poll()` or `flush()`. No poll, no callbacks, and eventually a full queue.
- `flush(timeout)` polls until the queue is empty and returns how many messages are still undelivered. Call it on shutdown, not after every message: a per-message flush caps throughput at one round-trip.

```python
import json
import logging
from uuid import UUID
from confluent_kafka import KafkaError, Message, Producer

log = logging.getLogger("booking-api.kafka")

def on_delivery(err: KafkaError | None, msg: Message) -> None:
    if err is not None:
        # after retries and delivery.timeout.ms: this record is NOT in Kafka
        log.error("delivery failed key=%s err=%s", msg.key(), err)
        return
    log.debug("delivered %s[%d]@%d", msg.topic(), msg.partition(), msg.offset())

def publish_booking_created(
    producer: Producer, *, booking_id: UUID, event_id: int, user_id: int, seats: list[str]
) -> None:
    payload = {
        "booking_id": str(booking_id), "event_id": event_id,
        "user_id": user_id, "seats": seats, "schema_version": 1,
    }
    while True:
        try:
            producer.produce(
                "booking.created",
                key=str(event_id).encode(),
                value=json.dumps(payload).encode(),
                headers={"event-type": b"booking.created"},
                on_delivery=on_delivery,
            )
            break
        except BufferError:
            producer.poll(0.5)  # local queue full: serve callbacks, then retry
    producer.poll(0)          # serve any ready callbacks without blocking
```

In FastAPI, create one producer per process at startup (lifespan), call `poll(0)` after each produce or from a small background thread, and `flush(10)` at shutdown. `produce()` is non-blocking, so calling it from an async endpoint is acceptable. If the endpoint must know the result before replying, see the asyncio note below.

### Consumer: subscribe, poll loop, commit, close

```python
import signal
from collections.abc import Callable
from confluent_kafka import Consumer, KafkaError, KafkaException, Message, TopicPartition

running = True

def _stop(*_: object) -> None:
    global running
    running = False

def on_assign(c: Consumer, parts: list[TopicPartition]) -> None:
    log.info("assigned %s", [p.partition for p in parts])

def on_revoke(c: Consumer, parts: list[TopicPartition]) -> None:
    log.info("revoked %s", [p.partition for p in parts])
    # with per-message sync commits there is nothing pending here;
    # with batched commits, commit what you finished now

def run(consumer: Consumer, handle: Callable[[Message], None]) -> None:
    signal.signal(signal.SIGTERM, _stop)
    consumer.subscribe(["booking.created"], on_assign=on_assign, on_revoke=on_revoke)
    try:
        while running:
            msg = consumer.poll(1.0)
            if msg is None:
                continue
            if msg.error():
                if msg.error().fatal():
                    raise KafkaException(msg.error())
                log.warning("consumer error: %s", msg.error())  # usually transient
                continue
            handle(msg)                                  # side effect first
            consumer.commit(message=msg, asynchronous=False)  # then the offset
    finally:
        consumer.close()  # leave the group now, not after session.timeout.ms
```

Key API facts, checked against the installed package:

- `poll(timeout)` returns one `Message` or `None`. `consume(num_messages, timeout)` returns a list.
- Every `Message` may be an error event. Always check `msg.error()` before `msg.value()`.
- `commit(message=msg)` commits `msg.offset() + 1`. `commit(offsets=[TopicPartition(t, p, off)])` commits exactly what you pass. With `asynchronous=False` it blocks and raises on failure.
- `subscribe()` also takes `on_lost`, called when partitions were taken away without a clean revoke (for example after exceeding `max.poll.interval.ms`). Do not commit there.
- With `cooperative-sticky`, `on_assign` and `on_revoke` receive only the partitions that change.
- `close()` commits only if auto-commit is on, then leaves the group.

### It is synchronous: give the worker its own process

`Consumer.poll()` blocks the calling thread. Running it inside FastAPI's event loop freezes request handling, and running it in a thread next to the web server ties the worker's lifecycle and rebalances to web deploys. Make the notification worker a separate entry point (`python -m booking.worker`) and a separate Compose service. One process, one consumer, one poll loop. Scale by running more containers, up to the partition count.

### Asyncio options

- **confluent-kafka `AIOProducer` / `AIOConsumer`** (`confluent_kafka.aio`): asyncio wrappers that push blocking librdkafka calls to a thread pool. Added as experimental in 2.12, no longer marked experimental since 2.13; some newer async serializer classes are still experimental. `await producer.produce(...)` resolves to the delivered message, which is handy when an endpoint must confirm the write. Per-message headers are not supported on its batched path.
- **aiokafka**: a native asyncio client built on kafka-python's protocol code. Idiomatic `async for msg in consumer`, but not librdkafka, so defaults, partitioner and feature coverage differ. Read its docs before mixing it with confluent-kafka producers on the same topic.

For this course: sync `Producer` in the API (it does not block), sync `Consumer` in a dedicated worker process.

### Mapping from KafkaJS / NestJS

| KafkaJS / NestJS idea | confluent-kafka equivalent | Difference to watch |
| --- | --- | --- |
| `producer.send({ topic, messages })` returns a Promise | `produce()` + delivery callback served by `poll()` | No promise; nothing reports until you poll |
| `kafka.producer({ idempotent: true })` | `"enable.idempotence": True` | Off by default in both; set it |
| `consumer.run({ eachMessage })` | your own `while` loop around `poll()` | You own the loop, the error handling and shutdown |
| `autoCommit` after `eachMessage` resolves | `enable.auto.commit=False` + `commit()` after handling | librdkafka auto-commit is timer based, not tied to your handler finishing |
| `@EventPattern('booking.created')` in a NestJS microservice | a dispatch dict from header or topic to handler function | No framework; keep the handler a pure function for tests |
| KafkaJS default partitioner (Java-compatible murmur2) | `"partitioner": "murmur2_random"` | librdkafka default is CRC32-based |

**Read more:** Confluent's Python client guide (docs.confluent.io, "Kafka Python Client"); the confluent-kafka-python CHANGELOG for asyncio and KIP-848 status; librdkafka `CONFIGURATION.md` for every property and default.

**Pitfalls**

- Never calling `poll()` on the producer. Callbacks never fire and errors go unseen.
- Calling `msg.value()` on an error event, or assuming `value()` is valid JSON. Malformed payloads must not crash the loop (capstone section).
- Sharing one `Consumer` across threads. It is not designed for that; use one per thread or, better, one per process.
- Creating a new `Producer` per request. Each one opens broker connections and gets a new PID, which also defeats idempotence.
- Blocking the asyncio loop with `Consumer.poll()` inside a FastAPI app.

## 9. Running locally: a 3-broker KRaft cluster

Three nodes in combined mode (each is both broker and controller) is the smallest cluster where replication, ISR shrinkage and leader failover behave like production. The official `apache/kafka` image turns any `KAFKA_*` environment variable into a broker setting: uppercase, dots become underscores (`num.partitions` becomes `KAFKA_NUM_PARTITIONS`). Once you set any of them, the image's built-in defaults are dropped, so you must supply the full set.

### Listeners in one paragraph

Each node needs three listeners. `CONTROLLER` (port 9093) carries Raft traffic between controllers. `PLAINTEXT` (19092) is for brokers and for containers on the Compose network, advertised as `kafka-N:19092`. `PLAINTEXT_HOST` (9092 inside, mapped to a unique host port) is for tools on your laptop, advertised as `localhost:<port>`. The advertised address is what a client is told to reconnect to after bootstrap, so it must be reachable from where that client runs. This is the most common cause of "connects, then hangs".

```yaml
# compose.kafka.yaml  (include from your main compose.yaml)
x-kafka-env: &kafka-env
  KAFKA_PROCESS_ROLES: broker,controller
  KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka-1:9093,2@kafka-2:9093,3@kafka-3:9093
  KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
  KAFKA_LISTENERS: PLAINTEXT://:19092,CONTROLLER://:9093,PLAINTEXT_HOST://:9092
  KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT
  KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
  CLUSTER_ID: <generate once, see below>
  KAFKA_LOG_DIRS: /tmp/kraft-combined-logs   # inside the container FS
  KAFKA_DEFAULT_REPLICATION_FACTOR: 3
  KAFKA_MIN_INSYNC_REPLICAS: 2
  KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 3
  KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 3
  KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 2
  KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false"
  KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: 0

services:
  kafka-1:
    image: apache/kafka:4.3.1
    hostname: kafka-1
    ports: ["29092:9092"]
    environment:
      <<: *kafka-env
      KAFKA_NODE_ID: 1
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka-1:19092,PLAINTEXT_HOST://localhost:29092
  # kafka-2 and kafka-3: same shape. Change hostname, NODE_ID,
  # host port (39092, 49092) and advertised listeners.
```

The shape follows the combined-mode example in the Apache Kafka repo (`docker/examples/.../cluster/combined/plaintext`); the replication settings are raised from that example's single-node values. Pin the image tag; 4.3.1 is the version the official quickstart uses as of October 2026. Generate the cluster ID once and paste it in, so all three nodes format with the same ID:

```bash
docker run --rm apache/kafka:4.3.1 /opt/kafka/bin/kafka-storage.sh random-uuid
```

Data lives in each container's filesystem, so it survives `docker compose stop`, `kill` and `start` (all you need for the failure drills) and disappears on `docker compose down`. If you later add named volumes, the image runs as a non-root user, so the mounted directory must be writable by it; a volume formatted with a different cluster ID makes the node refuse to start.

### CLI tools you will use this week

The tools live in `/opt/kafka/bin` inside the image. Run them through `docker compose exec` against the internal listener.

```bash
K="docker compose exec kafka-1 /opt/kafka/bin"
BS="--bootstrap-server kafka-1:19092"

# create the topic explicitly: 6 partitions, RF 3, min ISR 2
$K/kafka-topics.sh $BS --create --topic booking.created \
  --partitions 6 --replication-factor 3 --config min.insync.replicas=2

# who leads which partition, and who is in sync
$K/kafka-topics.sh $BS --describe --topic booking.created
# Topic: booking.created  Partition: 0  Leader: 2  Replicas: 2,3,1  Isr: 2,3,1 ...

# partitions whose ISR is smaller than the replica list
$K/kafka-topics.sh $BS --describe --under-replicated-partitions

# lag per partition for the worker's group
$K/kafka-consumer-groups.sh $BS --describe --group notifier

# replay: move the group back to the start (group must be stopped)
$K/kafka-consumer-groups.sh $BS --group notifier --topic booking.created \
  --reset-offsets --to-earliest --execute

# eyeball records with keys and partitions
$K/kafka-console-consumer.sh $BS --topic booking.created --from-beginning \
  --property print.key=true --property print.partition=true

# KRaft quorum health: leader, voters, lag
$K/kafka-metadata-quorum.sh $BS describe --status
```

**Read more:** Apache Kafka Docker examples README (GitHub, `docker/examples`); Kafka docs, KRaft operations page and quickstart; *Definitive Guide* ch. 2 for broker settings.

**Pitfalls**

- Advertising `localhost` to containers. The worker container then tries to reach itself. Containers must use `kafka-N:19092`.
- Using `apache/kafka:latest`. A silent upgrade can change defaults under you.
- Leaving the internal-topic replication factor at 1 (the single-node example values). Killing the broker holding `__consumer_offsets` then breaks every consumer group.
- Running the CLI against `localhost:29092` from inside a container. Inside, use the internal listener.
- Expecting `depends_on` to wait for Kafka readiness. Add a healthcheck (for example `kafka-topics.sh --list`) and `condition: service_healthy`, or retry connection in the app.

## Apply it to the capstone

Six build tasks plus tests. Each maps to sections above. The sketches show shape and key decisions; the wiring, error paths and naming are yours.

### Task 1: 3-broker KRaft Kafka in Compose (sections 5, 9)

- Start from the YAML in section 9 and add `kafka-2` and `kafka-3`. Point `api` and `worker` services at `kafka-1:19092,kafka-2:19092,kafka-3:19092` through an environment variable, never `localhost`.
- Add a one-shot `kafka-init` service that waits for the cluster and runs `kafka-topics.sh --create --if-not-exists` for `booking.created` (6 partitions, RF 3, `min.insync.replicas=2`). Make `api` and `worker` depend on it with `condition: service_completed_successfully`.
- Done when `kafka-topics.sh --describe` shows `Isr` with three brokers for every partition, and `kafka-metadata-quorum.sh describe --status` shows three voters.

### Task 2: publish booking.created keyed by event\_id (sections 2, 7, 8)

- One `Producer` per API process, created in FastAPI's lifespan and closed with `flush()`. Config: `enable.idempotence=True`, `acks=all`, `partitioner=murmur2_random`, a sensible `delivery.timeout.ms`.
- Produce only after the PostgreSQL transaction that reserved the seats has committed. Producing before commit can announce a booking that then rolls back.
- Key: `str(event_id).encode()`. Value: JSON with `booking_id` (UUID), `event_id`, `user_id`, `seats`, `created_at`, `schema_version`.
- Hint: write a small `BookingEvents` class with a `publish_created(booking)` method and inject it with `Depends`, so route tests can swap in a fake that records calls.
- Be honest about the gap: if the process dies between the DB commit and the delivery callback, the event is lost. Log it for now. The outbox pattern in the sibling doc fixes it properly.

```python
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from fastapi import FastAPI

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.producer = Producer(build_producer_conf(settings))
    yield
    remaining = app.state.producer.flush(10)
    if remaining:
        log.error("%d booking events not delivered at shutdown", remaining)
```

### Task 3: notification worker, commit after processing (sections 3, 4, 8)

- New entry point `python -m booking.worker`, its own Compose service, with `enable.auto.commit=False`, `group.id=notifier`, `auto.offset.reset=earliest`, `partition.assignment.strategy=cooperative-sticky`.
- Structure it as three layers so it is testable: `parse(msg) -> BookingCreated` (pure), `handle(event, deps) -> None` (side effects behind interfaces), and the poll loop (thin, not unit tested).
- In the loop: poll, check error, parse, handle, then `commit(message=msg, asynchronous=False)`. Close the consumer on SIGTERM.
- For "notified", write a row to a `notifications` table and log a line. A real email provider can come later.

### Task 4: kill a broker, watch leadership move (section 5)

1. Run `kafka-topics.sh --describe --topic booking.created` and note the leader of each partition.
2. Start a loop that creates bookings through the API every 200 ms.
3. `docker compose kill kafka-2`.
4. Describe again. Every partition that kafka-2 led has a new leader, and `Isr` lists two brokers. In the API logs, look for a burst of retriable errors and *no* failed deliveries.
5. Kill a second broker. Now ISR = 1 < `min.insync.replicas`. Delivery callbacks start failing with `NOT_ENOUGH_REPLICAS` after `delivery.timeout.ms`. That is the durability guarantee working: writes refused, nothing acknowledged on a single copy.
6. Start both brokers again and watch `--under-replicated-partitions` drain to empty.

Write down timings and what each client logged. That record is excellent interview material.

### Task 5: crash the worker mid-batch, observe redelivery (section 4)

- Add a debug-only env var, e.g. `CRASH_AFTER_N=3`, that makes the worker call `os._exit(1)` right after the side effect of the Nth message and *before* the commit. `os._exit` skips `finally`, so `close()` is not called: a real crash.
- Produce 10 bookings. The worker handles 3 and dies. Check lag: the committed offset is behind the third record.
- Restart without the env var. Record 3 is processed a second time. Without Task 6 you now have two notification rows for one booking. That duplicate is the proof that you are at-least-once.
- Variant: make the handler sleep longer than `max.poll.interval.ms` and watch the member get kicked, the partitions move, and the same record arrive twice.

### Task 6: idempotent consumer, dedupe on booking\_id (sections 4, 6)

The rule: the dedupe record and the side effect must commit in one database transaction. Then a crash either leaves both or neither, and a redelivery finds the record and skips.

```sql
CREATE TABLE processed_bookings (
    booking_id   uuid PRIMARY KEY,
    processed_at timestamptz NOT NULL DEFAULT now()
);
```

```python
def handle(event: BookingCreated, db: Session, notifier: Notifier) -> bool:
    """Returns False if this booking was already processed."""
    with db.begin():
        inserted = db.execute(
            insert(processed_bookings)
            .values(booking_id=event.booking_id)
            .on_conflict_do_nothing()
            .returning(processed_bookings.c.booking_id)
        ).first()
        if inserted is None:
            return False
        notifier.record(event)  # same transaction: notifications row
    return True
```

Think through the case where the side effect is outside the database, such as an email API. Then the transaction trick does not cover it. The usual answer is an idempotency key (the booking ID) passed to the email provider, or recording "sent" in the same row and accepting a small duplicate window. Write down which one you would pick and why.

### Tests: handler with fake messages

No broker in unit tests. Fake the `Message` with a tiny dataclass that exposes the methods your code calls.

```python
from dataclasses import dataclass

@dataclass
class FakeMessage:
    _value: bytes | None
    _key: bytes | None = b"42"
    _topic: str = "booking.created"
    _partition: int = 0
    _offset: int = 0
    def value(self) -> bytes | None: return self._value
    def key(self) -> bytes | None: return self._key
    def topic(self) -> str: return self._topic
    def partition(self) -> int: return self._partition
    def offset(self) -> int: return self._offset
    def error(self) -> None: return None
```

Cases to cover:

- [ ] Valid payload: one notification row and one `processed_bookings` row.
- [ ] Same payload twice (same `booking_id`, different offsets): still exactly one notification; second call returns False.
- [ ] Malformed JSON, missing `booking_id`, wrong types, `value()` is `None` (tombstone): `parse` raises a specific `InvalidMessage`; the loop logs it and commits past it so one poison record cannot block the partition. (Routing it to a dead-letter topic is the sibling doc's job.)
- [ ] Unknown `schema_version`: decide skip or fail, and test that decision.
- [ ] Handler raises a transient error (database down): no commit happens, so the record will be redelivered.
- [ ] Run against a real PostgreSQL (testcontainers or the Compose DB) for the `ON CONFLICT` path; mock nothing there.

For the loop itself, one integration test against the Compose cluster is enough: produce 5 records, run the worker until lag is zero, assert 5 rows.

## Check yourself

Answer out loud before opening the answers. Aim for two or three sentences each, with the mechanism, not just the conclusion.

1. Why can Kafka replay old messages when a classic message queue usually cannot?
2. A producer has `acks=all` and the topic has `replication.factor=3`. Can an acknowledged record still be lost? What setting closes the gap?
3. Explain how the idempotent producer prevents duplicates from retries. What kinds of duplicates does it *not* prevent?
4. Why does `max.in.flight.requests.per.connection=5` not break ordering when idempotence is on, but can break it when idempotence is off?
5. You have 6 partitions and scale the notification worker to 10 replicas. What happens and why?
6. Your worker's heartbeats are fine, but it keeps getting removed from the group and its records are processed twice. What is the likely cause and how do you fix it?
7. Compare commit-before-processing and commit-after-processing. Which delivery semantics does each give, and which would you choose for booking notifications?
8. Kafka advertises exactly-once semantics. Why does the notification worker still need idempotent processing?
9. What does `unclean.leader.election.enable=true` trade, and when could that be acceptable?
10. Why did you key `booking.created` by `event_id`, and what is the risk of that choice?
11. You increase `booking.created` from 6 to 12 partitions. What breaks, and how would you have avoided it?
12. Your Python service and a NestJS (KafkaJS) service both produce to the same topic with the same keys, but per-key order breaks. What do you check first?

## Answers

1. Kafka does not delete records when they are read. It keeps them until retention expires, and each consumer group only stores its next offset per partition. Resetting that offset re-reads history. A queue deletes a message once it is acknowledged.
2. Yes. `acks=all` waits for the current ISR, which can shrink to just the leader, so the write may exist on one broker. If that broker then fails, the record is gone. Set `min.insync.replicas=2` so the leader refuses writes when fewer than two replicas are in sync.
3. The producer gets a producer ID, and every batch carries a per-partition sequence number. The leader remembers recent sequences per PID and acknowledges, but does not re-append, a batch it has seen. It does not prevent duplicates across producer restarts (new PID) or from the application calling `produce()` twice for the same booking.
4. Without idempotence, batch 1 can fail while batch 2 succeeds, and the retry of batch 1 lands after batch 2. With idempotence, the broker rejects batch 2 as out of sequence until batch 1 is written, so order is restored on retry. The broker tracks up to five in-flight batches per producer, hence the limit of 5.
5. Six consumers get one partition each and four sit idle. Within a group one partition has one owner, so partition count caps parallelism. The idle ones only help as hot standbys during rebalances.
6. Processing between two `poll()` calls exceeds `max.poll.interval.ms`. Heartbeats come from a background thread, so they keep flowing, but the poll timeout removes the member. Its uncommitted records are redelivered to another member. Fix: process smaller batches, bound slow calls with timeouts, or raise the interval to fit the worst case.
7. Commit-before gives at-most-once: a crash after the commit skips the record. Commit-after gives at-least-once: a crash before the commit redelivers it. For notifications choose commit-after plus an idempotent handler, because a missed confirmation is worse than a deduplicated retry.
8. EOS covers only reads and writes inside Kafka: output records and consumer offsets committed atomically in one transaction. Sending an email or writing to PostgreSQL is outside that transaction, so a crash after the side effect and before the commit repeats it. Only idempotent processing makes that repeat harmless.
9. It trades durability for availability. When no in-sync replica is alive, an out-of-sync replica becomes leader and committed records it never received are lost. It can be acceptable for data where availability matters more than completeness, such as metrics or logs; never for bookings.
10. Same key, same partition, so all bookings for one event are read in order by one consumer. That keeps per-event state (seat booked, then released) consistent downstream. The risk is a hot partition when one event dominates traffic, because only one consumer can process that partition.
11. hash(key) mod N changes for many keys, so new records for an event go to a different partition than its older ones. Two consumers may then process one event's records out of order. Avoid it by over-provisioning partitions up front, or by creating a new topic and migrating after draining the old one.
12. The partitioner. confluent-kafka defaults to `consistent_random` (CRC32), while KafkaJS and Java use murmur2, so the same key maps to different partitions. Set `partitioner=murmur2_random` in Python. Also check that both use the same key encoding (same bytes).

## Sources

Versions and defaults checked in October 2026 against Kafka 4.3 docs and confluent-kafka 2.16.0 (librdkafka 2.16). API names were checked against the installed Python package.

**Apache Kafka**

- [Downloads and release dates](https://kafka.apache.org/community/downloads/)
- [Producer configs (4.3)](https://kafka.apache.org/43/configuration/producer-configs/)
- [Consumer configs (4.3)](https://kafka.apache.org/43/configuration/consumer-configs/)
- [Broker configs (4.3)](https://kafka.apache.org/43/configuration/broker-configs/)
- [Design: replication, delivery semantics, transactions (4.3)](https://kafka.apache.org/43/design/design/)
- [Consumer rebalance protocol, KIP-848 (4.3)](https://kafka.apache.org/43/operations/consumer-rebalance-protocol/)
- [KRaft operations (4.3)](https://kafka.apache.org/43/operations/kraft/)
- [Quickstart (4.3)](https://kafka.apache.org/43/getting-started/quickstart/)
- [Upgrading to 4.0 notes](https://kafka.apache.org/40/getting-started/upgrade/)
- [Apache Kafka 4.0.0 release announcement](https://kafka.apache.org/blog/2025/03/18/apache-kafka-4.0.0-release-announcement/)
- [KIP-794: Strictly Uniform Sticky Partitioner](https://cwiki.apache.org/confluence/display/KAFKA/KIP-794%3A+Strictly+Uniform+Sticky+Partitioner)

**Docker**

- [apache/kafka image on Docker Hub](https://hub.docker.com/r/apache/kafka)
- [Kafka Docker examples README](https://github.com/apache/kafka/blob/trunk/docker/examples/README.md)
- [Combined-mode 3-node Compose example](https://github.com/apache/kafka/blob/trunk/docker/examples/docker-compose-files/cluster/combined/plaintext/docker-compose.yml)

**Python clients**

- [Confluent: Kafka Python client guide](https://docs.confluent.io/kafka-clients/python/current/overview.html)
- [confluent-kafka-python CHANGELOG](https://github.com/confluentinc/confluent-kafka-python/blob/master/CHANGELOG.md)
- [librdkafka CONFIGURATION.md](https://github.com/confluentinc/librdkafka/blob/master/CONFIGURATION.md)
- [aiokafka documentation](https://aiokafka.readthedocs.io/en/stable/)
- [KafkaJS: producing](https://kafka.js.org/docs/producing)

**Courses**

- [Confluent Kafka 101: Partitions](https://developer.confluent.io/courses/apache-kafka/partitions/)
- [Confluent Kafka Internals: Transactions](https://developer.confluent.io/courses/architecture/transactions/)

**Book:** *Kafka: The Definitive Guide*, 2nd ed.: ch. 3 Producers, ch. 4 Consumers, ch. 6 Internals, ch. 7 Reliable Data Delivery, ch. 8 Exactly-Once Semantics. Where its defaults differ from section 2, the book describes the Java client of its time; trust the current docs.
