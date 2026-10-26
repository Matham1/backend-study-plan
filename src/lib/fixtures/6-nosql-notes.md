# Study Notes — Week 6: NoSQL Introduction

Oct 23, 2026 · @Mathew Matholomew

After these notes you should be able to explain why NoSQL stores exist, how they store and distribute data underneath, and what you lose when you leave Postgres. You will practise the core skill of the week: modelling the same event-booking data as MongoDB documents, DynamoDB items and Cassandra tables, starting from access patterns. You will also be able to defend, in interview language, why seat inventory in the capstone stays strongly consistent in PostgreSQL while notifications and leaderboards can be eventual.

## 1. Why NoSQL exists

NoSQL stores trade general-purpose querying for one of three things: horizontal scale, schema flexibility, or speed on a known access pattern. "NoSQL" is not one technology. It is a label for systems that dropped some relational guarantees on purpose.

**Scale-out.** A single Postgres primary scales up: more CPU, RAM and faster disks. Eventually one machine is not enough for write volume or data size. Joins and multi-row transactions are hard to keep fast when rows live on different machines, because every join or commit may need a network round trip and coordination. Many NoSQL systems were designed from day one to split data across many nodes (sharding) and copy it (replication). To make that cheap, they limit operations to ones that touch a single shard: get by key, write by key, scan within one partition.

**Flexible schemas.** A document store accepts records of different shapes in one collection. This is useful when the shape really varies (product catalogues with per-category attributes, event payloads from many producers). It is "schema-on-read": the structure still exists, but your application code enforces it instead of the database.

**Access-pattern-specific stores.** Each family is optimised for one shape of query. Redis answers key lookups from memory in microseconds. Cassandra absorbs huge write rates. Neo4j walks relationships without join cost per hop. You pick the store whose strengths match the query you run most.

### What you give up

| Relational feature | Typical NoSQL situation | Consequence for you |
| --- | --- | --- |
| Joins | Absent or limited (MongoDB has `$lookup`, DynamoDB and Cassandra have none) | You denormalise: copy data into the shape each read needs |
| Multi-row ACID transactions | Single-item/document atomicity by default; transactions exist in MongoDB and DynamoDB but cost more and have limits | Invariants spanning records need careful design |
| Ad-hoc queries | Fast queries only on keys and indexes you planned for | A new question may need a new table, index, or a backfill job |
| Foreign keys, constraints | Rare | Referential integrity moves into application code |
| Strong consistency everywhere | Often eventual by default, tunable | You must reason about stale reads |

### Postgres already covers many "document" needs

Before reaching for MongoDB, remember that Postgres has `jsonb`. It stores JSON in a parsed binary form, supports GIN indexes, and has a containment operator `@>`. The Postgres docs recommend `jsonb` over `json` for most applications. You keep transactions, joins and constraints on the relational columns, and get schema flexibility for the varying part.

```sql
-- Fixed columns for what you query and constrain; jsonb for the varying part
CREATE TABLE events (
    id          bigserial PRIMARY KEY,
    title       text NOT NULL,
    starts_at   timestamptz NOT NULL,
    capacity    int NOT NULL CHECK (capacity > 0),
    attributes  jsonb NOT NULL DEFAULT '{}'   -- e.g. {"genre": "jazz", "age_limit": 18}
);

CREATE INDEX events_attrs_gin ON events USING GIN (attributes jsonb_path_ops);

-- Uses the GIN index via containment
SELECT id, title FROM events WHERE attributes @> '{"genre": "jazz"}';
```

The `jsonb_path_ops` operator class makes a smaller, faster index for `@>` but cannot answer key-existence queries (`?`). Use the default `jsonb_ops` if you need those.

**Pitfalls**

- Choosing NoSQL for "scale" when one Postgres instance with good indexes and a read replica would carry you for years.
- Treating "schemaless" as "no schema". The schema moves into code, and migrations become application-level backfills.
- Forgetting that relational features you rely on silently (unique constraints, FK checks, `SELECT ... FOR UPDATE`) must be rebuilt by hand.
- Putting everything in one `jsonb` column. Columns you filter, join or constrain on should stay real columns.

## 2. The four families

The families differ in what the database understands about your value. A key-value store sees an opaque blob behind a key. A document store parses the value and can index fields inside it. A wide-column store organises rows inside a partition in sorted order. A graph store treats relationships as first-class data.

- **Key-value (Redis, DynamoDB).** `get(key)`, `put(key, value)`, sometimes with TTLs and atomic counters. Redis keeps data in memory and adds data structures (sorted sets, streams). DynamoDB is a managed, disk-backed store that extends the model with a sort key, so it sits between key-value and wide-column.
- **Document (MongoDB).** JSON-like documents (BSON) grouped in collections. You can query and index nested fields. Single-document writes are atomic.
- **Wide-column (Cassandra, ScyllaDB).** Tables with a partition key that picks the node, and clustering columns that sort rows inside the partition. Built for high write throughput across many nodes and data centres.
- **Graph (Neo4j).** Nodes and relationships with properties. Traversals like "friends of friends who booked jazz events" cost per edge followed, not per table joined.

|  | Key-value | Document | Wide-column | Graph |
| --- | --- | --- | --- | --- |
| Representative | Redis, DynamoDB | MongoDB | Cassandra, ScyllaDB | Neo4j |
| Data model | Key to opaque value (DynamoDB: key + sort key to item) | Nested documents in collections | Partitions of sorted rows | Nodes, typed edges, properties |
| Query style | Get/put by key; DynamoDB `Query` inside one partition | Rich filter language, aggregation pipeline, secondary indexes | CQL by partition key plus clustering range | Pattern matching (Cypher) |
| Consistency | Redis: async replication; DynamoDB: eventual or strong reads per request on the base table | Tunable via read/write concern; strong from the primary by default | Tunable per query (ONE, QUORUM, ALL) | Typically ACID on a single instance or leader |
| Typical use | Cache, sessions, rate limits, carts, leaderboards | Catalogues, user profiles, content, per-entity aggregates | Time series, event logs, messaging, IoT, activity feeds | Recommendations, fraud rings, access-control graphs |
| Bad fit | Queries by anything but the key; reporting | Many-to-many data with heavy cross-document joins | Ad-hoc queries, read-modify-write, small datasets | Bulk aggregation, simple CRUD |

In the capstone you already use one NoSQL store: Redis. That is the point of this week. You are not replacing Postgres; you are learning where a second store earns its keep.

**Pitfalls**

- Calling DynamoDB "just key-value". Its sort key and item collections make it closer to a managed wide-column store.
- Using a graph database because the domain has relationships. Every domain has relationships. Use it when multi-hop traversal is the core query.
- Using Redis as the primary store for data you cannot lose without configuring persistence (AOF/RDB) and accepting its async replication.

## 3. Storage engines: B-trees vs LSM-trees

The storage engine decides what a write costs and what a read costs. Most relational databases (Postgres, MySQL InnoDB) and MongoDB's WiredTiger default use B-tree style structures. Cassandra, ScyllaDB, RocksDB, HBase and the storage beneath many key-value stores use LSM-trees. Reference: DDIA 2nd ed., chapter 4 "Storage and Retrieval", sections on log-structured storage, B-trees and comparing the two.

### B-trees: update in place

A B-tree keeps keys sorted in fixed-size pages (Postgres uses 8 KB). Pages form a shallow tree, usually 3 to 4 levels deep, so a lookup touches a handful of pages. To write, the engine finds the leaf page that holds the key and modifies it in place. If the page is full it splits, and the parent gets a new pointer. A write-ahead log (WAL) records the change first so a crash cannot leave a half-written page.

Cost profile: reads are predictable (one path from root to leaf). Writes are random I/O, and each small change rewrites a whole page plus a WAL record. That rewrite ratio is write amplification.

### LSM-trees: append now, sort later

An LSM-tree (log-structured merge-tree) never modifies data files in place.

1. The write is appended to a commit log for durability. This is a sequential write.
2. The write goes into the memtable, a sorted in-memory structure. The write is now acknowledged.
3. When the memtable is full, it is flushed to disk as an SSTable (sorted string table): an immutable file of sorted keys. A new memtable takes over.
4. Over time there are many SSTables, some holding older versions of the same key. Compaction merges them in the background, keeping the newest value and discarding overwritten or deleted ones (deletes are written as markers called tombstones).

Reads check the memtable first, then SSTables from newest to oldest. To avoid opening every file, each SSTable has a bloom filter: a compact bit array that answers "this key is definitely not here" or "maybe here". A negative answer skips the file entirely.

&#91;embedded content: LSM-tree write and read path\]

Only the two highlighted steps sit on the write's critical path; flushing and compaction happen later, off the request.

### Amplification trade-offs

|  | B-tree | LSM-tree |
| --- | --- | --- |
| Write path | Find page, modify in place, WAL | Append to log, insert in memtable |
| Write amplification | Whole page rewritten per small change | Same data rewritten by each compaction level |
| Read amplification | Low: one root-to-leaf path | Higher: memtable plus possibly several SSTables (bloom filters help point reads, not range scans) |
| Space amplification | Free space inside pages (fragmentation) | Stale versions until compaction runs |
| Typical sweet spot | Read-heavy OLTP, range scans, transactions | Write-heavy ingestion, time series, logs |

Both amplifications exist in both engines. The question is where you pay. B-trees pay on every write. LSM-trees defer the cost to compaction, which competes for disk bandwidth with live traffic.

### Why Cassandra writes are cheap

A Cassandra write is a commit-log append plus a memtable insert. There is no read before the write: Cassandra does not check whether the row exists, it just records a new version with a timestamp. Updates and inserts are the same operation (an "upsert"). Combine that with writes going to all replicas in parallel and you get very high write throughput on commodity disks.

The flip side: a read may merge several SSTables, deletes leave tombstones that slow reads until compaction, and read-modify-write ("decrement seats if > 0") needs extra machinery (lightweight transactions, which use Paxos and are much slower).

**Pitfalls**

- Assuming LSM means "faster". It means faster writes; point reads are close with bloom filters, range reads and heavy-delete workloads can be slower.
- Ignoring compaction. Unthrottled compaction causes latency spikes; too little leaves many SSTables and slow reads.
- Using Cassandra as a queue (insert then delete). Tombstones accumulate and reads degrade.
- Forgetting that B-tree engines also batch and buffer; Postgres is not slow at writes for normal OLTP volumes.

## 4. Document modelling in MongoDB

In SQL you normalise first and write queries later. In MongoDB you design documents around how the application reads and writes them. The unit that matters is the document: a write to one document is atomic, and a read of one document is one fetch. So the core decision is what goes inside one document.

### Embed vs reference: rules of thumb

| Embed when | Reference when |
| --- | --- |
| Child belongs to the parent ("has-a") | Child has high cardinality or grows without bound |
| You read them together almost always | Child is read or written on its own |
| They change together and must change atomically | Many parents share the child (many-to-many) |
| Child count is small and bounded (tens, maybe hundreds) | Embedding would duplicate data that changes often |
| Child has no life without the parent | Child is written at different times in a write-heavy workload |

Hard limits push you too: a BSON document is capped at 16 MiB, nesting depth at 100 levels, and a collection can have at most 64 indexes. Long before 16 MiB, big documents hurt: every read pulls the whole document into cache, and every update to a growing array rewrites more bytes.

**Document growth** is the trap to watch. An array that grows with user activity (bookings per event, comments per post) has no natural bound. A sold-out 20,000-seat concert would be 20,000 embedded bookings in one hot document that every booking request must lock and rewrite.

### The capstone's SQL schema (for comparison)

```sql
CREATE TABLE events   (id bigserial PRIMARY KEY, title text, venue text,
                       starts_at timestamptz, capacity int, seats_left int CHECK (seats_left >= 0));
CREATE TABLE users    (id bigserial PRIMARY KEY, email text UNIQUE, name text);
CREATE TABLE bookings (id bigserial PRIMARY KEY,
                       event_id bigint REFERENCES events(id),
                       user_id  bigint REFERENCES users(id),
                       seats int CHECK (seats > 0), status text,
                       created_at timestamptz DEFAULT now(),
                       UNIQUE (event_id, user_id));
```

The database enforces "no overselling" with the `CHECK` plus a transaction that decrements `seats_left` and inserts the booking together.

### Option A: embed bookings in the event

```json
{
  "_id": "evt_42",
  "title": "Astana Jazz Night",
  "venue": {"name": "Congress Hall", "city": "Astana"},
  "starts_at": {"$date": "2026-12-05T19:00:00Z"},
  "capacity": 300,
  "seats_left": 297,
  "bookings": [
    {"booking_id": "bk_9001", "user_id": "usr_7", "user_name": "Mathew", "seats": 2, "status": "confirmed"},
    {"booking_id": "bk_9002", "user_id": "usr_11", "user_name": "Aruzhan", "seats": 1, "status": "confirmed"}
  ]
}
```

Upside: booking and decrementing seats is one atomic single-document update, so no multi-document transaction is needed. Downsides: unbounded array, a single hot document for popular events, and "my bookings" for a user needs a multikey index on `bookings.user_id` and returns whole event documents. `user_name` is a denormalised copy that goes stale if the user renames.

### Option B: reference (separate collections)

```json
// events
{"_id": "evt_42", "title": "Astana Jazz Night", "venue": {"name": "Congress Hall", "city": "Astana"},
 "starts_at": {"$date": "2026-12-05T19:00:00Z"}, "capacity": 300, "seats_left": 297}

// bookings
{"_id": "bk_9001", "event_id": "evt_42", "user_id": "usr_7", "seats": 2, "status": "confirmed",
 "event_title": "Astana Jazz Night", "event_starts_at": {"$date": "2026-12-05T19:00:00Z"},
 "created_at": {"$date": "2026-10-23T09:12:00Z"}}
```

This mirrors SQL, with one twist: `event_title` and `event_starts_at` are copied into the booking (the extended-reference pattern) so "my bookings" renders without a second query. Bookings scale independently. The cost: decrementing `seats_left` and inserting the booking touch two documents. You either use a multi-document transaction, or do a conditional decrement first and compensate if the insert fails.

**Verdict for the capstone:** Option B. Bookings are unbounded and queried by user; events are read far more often than they are booked. Embed only bounded, owned data, such as the venue or a short list of ticket tiers.

### Indexes in MongoDB

MongoDB indexes are B-trees, like Postgres. The rules carry over: compound index field order matters, and an index serves queries on its prefix. A useful ordering heuristic is Equality, Sort, Range (ESR): equality-matched fields first, then sort fields, then range filters.

```python
bookings.create_index([("user_id", 1), ("created_at", -1)])   # my bookings, newest first
bookings.create_index([("event_id", 1), ("status", 1)])       # bookings for an event
bookings.create_index([("event_id", 1), ("user_id", 1)], unique=True)  # one booking per user per event
```

An index on an array field becomes multikey (one index entry per element). That is how Option A could query `bookings.user_id`, at the cost of a large index.

### Driver: use the PyMongo Async API, not Motor

Motor, the long-standing async driver, was deprecated on 14 May 2025 in favour of the PyMongo Async API (`AsyncMongoClient`, inside the `pymongo` package). Motor reached end of life on 14 May 2026 and gets only critical fixes until 14 May 2027. Motor ran blocking calls on a thread pool; PyMongo Async uses native asyncio. One practical difference: an `AsyncMongoClient` is not thread-safe, so create it once per event loop (for FastAPI, in the lifespan handler).

```python
# FastAPI + PyMongo Async: book seats without overselling (Option B)
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException
from pymongo import AsyncMongoClient, ReturnDocument

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.mongo = AsyncMongoClient("mongodb://mongo:27017/?replicaSet=rs0")
    yield
    await app.state.mongo.close()

app = FastAPI(lifespan=lifespan)

async def book(event_id: str, user_id: str, seats: int) -> dict:
    db = app.state.mongo.booking
    async with app.state.mongo.start_session() as session:
        async with await session.start_transaction():
            # Conditional decrement: only matches if enough seats remain
            event = await db.events.find_one_and_update(
                {"_id": event_id, "seats_left": {"$gte": seats}},
                {"$inc": {"seats_left": -seats}},
                return_document=ReturnDocument.AFTER,
                session=session,
            )
            if event is None:
                raise HTTPException(409, "Not enough seats")
            doc = {
                "event_id": event_id, "user_id": user_id, "seats": seats,
                "status": "confirmed", "event_title": event["title"],
                "created_at": datetime.now(timezone.utc),
            }
            doc["_id"] = (await db.bookings.insert_one(doc, session=session)).inserted_id
            return doc
```

The filter `seats_left >= seats` combined with `$inc` is the document-store equivalent of `UPDATE ... SET seats_left = seats_left - :n WHERE seats_left >= :n`. It is atomic on one document even without the transaction. The transaction exists so the booking insert and the decrement commit together. Transactions need a replica set, even a single-node one in Docker Compose. Note the shapes: `start_session()` is used directly as an async context manager, while `start_transaction()` is awaited first. For automatic retries on transient errors, `await session.with_transaction(callback)` is the alternative; its callback may run more than once, so keep it free of external side effects.

**Pitfalls**

- Embedding unbounded arrays (bookings, comments, logs) in a parent document.
- Porting a normalised SQL schema table-for-collection and then writing `$lookup` everywhere.
- Reading `seats_left`, checking it in Python, then writing. That is a race; put the check in the update filter.
- Starting new projects on Motor, or sharing one `AsyncMongoClient` across threads or event loops.
- Forgetting that denormalised copies (`event_title` in bookings) need an update path when the source changes.

## 5. Access-pattern-first design in DynamoDB

DynamoDB inverts SQL design. In Postgres you model entities, then any query works with the right index. In DynamoDB you list every access pattern first, then design keys so each pattern is a single `GetItem` or `Query`. There are no joins, and `Scan` reads the whole table, so a pattern you did not plan for is expensive.

### Keys and item collections

- **Partition key (PK).** Hashed to pick the physical partition. All items with the same PK live together.
- **Sort key (SK).** Orders items inside one partition. `Query` takes one PK value plus an optional SK condition (`=`, `begins_with`, `between`, `<`, `>`), and returns items in SK order.
- **Item collection.** All items sharing a PK. This is how you "pre-join": put the parent and its children under the same PK with different SK prefixes, and one `Query` returns them together.
- **Item size** is limited to 400 KB.

### Single-table design

You store several entity types in one table, using generic attribute names (`PK`, `SK`, `GSI1PK`, `GSI1SK`) and prefixed values. The goal is not tidiness; it is that related items share a partition so one request returns them. Many teams use one table per bounded context instead. Both are valid; single-table pays off when you truly need cross-entity queries in one call.

### Access patterns for the capstone

1. Get event details by id.
2. List bookings for an event (organiser view).
3. List bookings for a user, newest first ("my bookings").
4. Get a specific booking by id.
5. Book seats without overselling; one booking per user per event.

### Key design

| Entity | PK | SK | GSI1PK | GSI1SK | Other attributes |
| --- | --- | --- | --- | --- | --- |
| Event | `EVENT#evt_42` | `META` |  |  | title, starts\_at, capacity, seats\_left |
| Booking | `EVENT#evt_42` | `BOOKING#usr_7` | `USER#usr_7` | `2026-10-23T09:12:00Z#evt_42` | seats, status, event\_title |
| User | `USER#usr_7` | `PROFILE` |  |  | name, email |

How each pattern is served:

| Pattern | Operation |
| --- | --- |
| 1. Event by id | `GetItem(PK=EVENT#evt_42, SK=META)` |
| 2. Bookings by event | `Query(PK=EVENT#evt_42, SK begins_with BOOKING#)` |
| 3. Bookings by user | `Query` on GSI1 with `GSI1PK=USER#usr_7`, `ScanIndexForward=false` for newest first |
| 4. Booking by id | Use the natural key (event + user) as the id, so it is a `GetItem` |
| 5. No overselling | `TransactWriteItems`: conditional update on the event + conditional put of the booking |

Putting the user id in the booking's SK gives "one booking per user per event" for free: a second put with the same PK and SK targets the same item, and `attribute_not_exists(SK)` rejects it.

### Global secondary indexes (GSIs)

A GSI is a second copy of selected attributes with a different PK/SK. It lets you query by another key. Important properties:

- GSIs are updated **asynchronously**. Reads from a GSI are eventually consistent only; strongly consistent reads are not supported. A user who books and immediately opens "my bookings" may not see the new booking for a moment.
- GSI keys do not have to be unique. Items missing the GSI key attribute are left out (a "sparse index"), which is a cheap filter.
- If a GSI lacks write capacity, writes to the **base table** get throttled. Give GSIs at least the base table's write capacity in provisioned mode.

### Capacity and hot partitions

Capacity is measured in units. One read unit covers one strongly consistent read per second (or two eventually consistent) of an item up to 4 KB; one write unit covers one write per second of up to 1 KB. Each partition delivers at most 3,000 read units and 1,000 write units per second, whatever the table's total. On-demand mode removes capacity planning, not this per-partition ceiling. Adaptive capacity shifts throughput toward busy partitions, but one key that alone exceeds the limit stays throttled.

That makes `EVENT#evt_42` a hot-partition risk during a big on-sale: every booking writes to the event item. Mitigations: keep the counter item small, shard the seat counter into N items (`EVENT#evt_42#SHARD#0..9`, each holding a slice of seats), or put a queue in front of the booking path.

### No overselling: conditional writes and transactions

A `ConditionExpression` is checked atomically against the current item. If it is false, the write does nothing and the SDK raises `ConditionalCheckFailedException`. `TransactWriteItems` groups up to 100 actions (4 MB total) into an all-or-nothing write; two actions cannot target the same item. A `ClientRequestToken` makes a retried transaction idempotent for 10 minutes.

```python
import boto3
from datetime import datetime, timezone
from botocore.exceptions import ClientError

ddb = boto3.client("dynamodb")

class SoldOut(Exception): ...
class AlreadyBooked(Exception): ...

def book(event_id: str, user_id: str, seats: int, request_id: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    try:
        ddb.transact_write_items(
            ClientRequestToken=request_id,           # idempotent retries
            TransactItems=[
                {"Update": {
                    "TableName": "booking",
                    "Key": {"PK": {"S": f"EVENT#{event_id}"}, "SK": {"S": "META"}},
                    "UpdateExpression": "SET seats_left = seats_left - :n",
                    "ConditionExpression": "seats_left >= :n",
                    "ExpressionAttributeValues": {":n": {"N": str(seats)}},
                }},
                {"Put": {
                    "TableName": "booking",
                    "Item": {
                        "PK": {"S": f"EVENT#{event_id}"}, "SK": {"S": f"BOOKING#{user_id}"},
                        "GSI1PK": {"S": f"USER#{user_id}"}, "GSI1SK": {"S": f"{now}#{event_id}"},
                        "seats": {"N": str(seats)}, "status": {"S": "confirmed"},
                    },
                    "ConditionExpression": "attribute_not_exists(SK)",   # one booking per user
                }},
            ],
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "TransactionCanceledException":
            raise
        codes = [r.get("Code") for r in e.response.get("CancellationReasons", [])]
        if codes and codes[0] == "ConditionalCheckFailed":
            raise SoldOut from e
        if len(codes) > 1 and codes[1] == "ConditionalCheckFailed":
            raise AlreadyBooked from e
        raise
```

The two items share a partition key here, which is convenient but not required; transactions can span items, partitions and tables. If you only needed the counter (no booking item), a single `UpdateItem` with the same `ConditionExpression` would be enough and cheaper. Transactional writes consume more capacity than standard writes (about double), so use them only where the invariant spans items.

**Pitfalls**

- Designing the table before writing down the access patterns.
- Reading `seats_left`, checking in code, then writing. Put the check in the `ConditionExpression`.
- Expecting read-your-writes from a GSI. Read the base table with `ConsistentRead=True` when it matters.
- Using a low-cardinality partition key (status, date, one global counter) and creating a hot partition.
- Treating `Scan` + `FilterExpression` as a query. Filters apply after items are read and billed.

## 6. Wide-column: Cassandra in brief

Cassandra's primary key has two parts, and each has one job. The partition key picks which nodes store the row (via a hash token). The clustering columns sort rows inside that partition on disk. A query must name the full partition key, and may then filter or range over clustering columns in order. Anything else needs a different table.

### Query-first table design

You design one table per query and accept duplication. For "bookings by event" and "bookings by user" you write two tables and insert into both.

```sql
-- Q1: bookings for an event, newest first
CREATE TABLE bookings_by_event (
    event_id   text,
    booked_at  timestamp,
    booking_id uuid,
    user_id    text,
    seats      int,
    status     text,
    PRIMARY KEY ((event_id), booked_at, booking_id)
) WITH CLUSTERING ORDER BY (booked_at DESC, booking_id ASC);

-- Q2: a user's bookings, newest first
CREATE TABLE bookings_by_user (
    user_id     text,
    booked_at   timestamp,
    booking_id  uuid,
    event_id    text,
    event_title text,
    seats       int,
    PRIMARY KEY ((user_id), booked_at, booking_id)
) WITH CLUSTERING ORDER BY (booked_at DESC, booking_id ASC);

SELECT * FROM bookings_by_user WHERE user_id = 'usr_7' LIMIT 20;      -- one partition, already sorted
SELECT * FROM bookings_by_event WHERE event_id = 'evt_42'
         AND booked_at > '2026-10-01';                                    -- range on a clustering column
```

Writes to both tables can go in a logged batch, which guarantees both eventually apply but is not isolated. `booking_id` sits in the clustering key so two bookings at the same millisecond do not overwrite each other (remember: inserts are upserts).

Partition sizing matters. A partition should stay well below hundreds of megabytes. A popular event with millions of rows, or a time-series key with no time bucket, grows a giant partition that one node must serve. The usual fix is bucketing: `PRIMARY KEY ((event_id, day), ...)`.

### Tunable consistency

With replication factor N, every write is sent to all N replicas. The consistency level only says how many replicas must acknowledge before the coordinator answers the client.

| Level | Waits for | Use when |
| --- | --- | --- |
| `ONE` | 1 replica | Lowest latency; stale reads acceptable (feeds, metrics) |
| `QUORUM` | Majority of all replicas (2 of 3) | Read-your-writes when both reads and writes use it |
| `LOCAL_QUORUM` | Majority in the local data centre | The common production default for multi-DC |
| `ALL` | Every replica | Rarely; one down node fails the request |
| `ANY` (writes only) | Any node, even a stored hint | Maximum write availability, weakest durability |

The rule behind it is R + W > N: if the replicas you read from overlap the replicas that acknowledged the write, at least one has the latest value. With N = 3, `QUORUM` writes (W = 2) plus `QUORUM` reads (R = 2) give 4 > 3.

### Why Cassandra is a poor fit for seat inventory

"Decrement seats if enough remain" is a read-modify-write. Normal Cassandra writes are blind upserts with last-write-wins by timestamp, so two concurrent bookings can both read 1 seat left and both succeed. Lightweight transactions (`UPDATE ... IF seats_left = 1`) fix this with a Paxos round, at several times the latency, and they should not be mixed with non-LWT writes on the same data. Cassandra shines for the booking history and activity log, not the counter.

**Pitfalls**

- Querying without the partition key, or adding `ALLOW FILTERING` to make an error go away. That is a cluster-wide scan.
- Modelling entities instead of queries, then discovering you need joins.
- Unbounded partitions (no time bucket) and heavy deletes that pile up tombstones.
- Believing `QUORUM` makes Cassandra serialisable. It gives overlap for reads after writes, not atomic read-modify-write.

## 7. Distribution: replication and sharding

Every distributed store answers two separate questions. Replication: how many copies of each piece of data exist, and who accepts writes? Sharding (also called partitioning): which machine holds which piece? Most systems do both: each shard is replicated. References: DDIA 2nd ed., chapter 6 "Replication" and chapter 7 "Sharding".

### Replication: three designs

| Design | How writes flow | Strengths | Costs | Examples |
| --- | --- | --- | --- | --- |
| Single-leader | All writes go to one leader, which streams changes to followers | Simple; no write conflicts; easy strong reads from leader | Leader is a write bottleneck; failover can lose unreplicated writes if async | Postgres streaming replication, MongoDB replica sets |
| Multi-leader | Several leaders (often one per data centre) accept writes and sync with each other | Local writes in each region; survives DC outage | Write conflicts need resolution (last-write-wins, merge, CRDTs) | Multi-region setups, collaborative and offline apps |
| Leaderless | Client or coordinator sends writes to several replicas directly; reads also query several | No failover step; tolerates slow or dead nodes | Needs quorums, read repair, anti-entropy; conflicts still possible | Cassandra, ScyllaDB, Riak, original Dynamo |

**Sync vs async.** With synchronous replication the leader waits for a follower before acknowledging, so a confirmed write survives leader loss, but one slow follower stalls writes. With asynchronous replication writes are fast, but followers lag. That lag is where stale reads come from (section 8).

**Quorums in leaderless systems.** With N replicas, a write waits for W acknowledgements and a read queries R replicas. If R + W > N, the read set and write set share at least one replica, so the read sees the latest acknowledged write (the reader picks the newest version by timestamp or version). Typical choice: N = 3, W = 2, R = 2. Edge cases still exist: concurrent writes, a failed write that partly landed, or "sloppy" quorums that write to stand-in nodes during outages. Quorums give overlap, not linearizability.

### Sharding: hash vs range

| Strategy | How a key maps to a shard | Good at | Bad at |
| --- | --- | --- | --- |
| Range | Contiguous key ranges (A to F, G to M, ...) | Range scans, ordered queries | Hot spots when keys are sequential (timestamps, auto-increment ids) |
| Hash | hash(key) picks the shard | Even spread of load | Range queries across keys hit every shard |
| Hash + range (compound) | Hash the first key part, sort by the rest | Spread across partitions, ordered within one | Only ranges inside one partition key |

The last row is exactly DynamoDB's PK + SK and Cassandra's partition key + clustering columns.

**Why not `hash(key) mod N`?** When N changes from 4 to 5, almost every key maps to a different node, and you move nearly the whole dataset. Consistent hashing fixes this.

### Consistent hashing

Place both nodes and keys on a ring of hash values. A key belongs to the first node found walking clockwise from its hash. The next N-1 distinct nodes hold its replicas. When a node joins, it takes over only the arc between itself and its predecessor; when it leaves, only its arc moves to the next node.

&#91;embedded content: consistent hashing ring · 4 nodes + 1 joining\]

Only keys on the highlighted arc (C to E) change owner when E joins; keys owned by A, B and C stay put.

With one point per node, arcs are uneven and a joining node relieves only one neighbour. Virtual nodes (vnodes) give each physical node many points on the ring, so load evens out and a new node takes small slices from many peers. Cassandra uses this, with a token allocator in modern versions.

### Hot keys

Hashing spreads keys, not traffic. If one key is hot (a celebrity's profile, a sold-out concert's seat counter), its shard gets all of it, whatever the hash. Remedies:

- Split the key: append a suffix (`evt_42#0` to `evt_42#9`) and spread writes; readers aggregate the pieces.
- Cache hot reads (Redis, CDN) so the shard sees fewer reads.
- Queue hot writes and process them at a rate the shard can sustain.

### Rebalancing

Rebalancing moves shards when nodes join, leave or fill up. Common approaches: a fixed number of shards much larger than nodes, assigned and moved whole (Elasticsearch, Riak); dynamic splitting of ranges when they grow (HBase, MongoDB chunks, DynamoDB partitions); or proportional to nodes via vnodes (Cassandra). Rebalancing competes with live traffic, so many teams want a human to approve it rather than fully automatic moves that can cascade during an incident. A router (client library, proxy, or config service like ZooKeeper) must learn the new layout.

**Pitfalls**

- Sharding before you need to. A single Postgres primary plus read replicas handles more than most products ever reach.
- Sequential keys (timestamps, auto-increment) as range-shard keys: every new write hits the last shard.
- Assuming replicas are always current. Async followers lag; reads from them can go back in time.
- Treating R + W > N as a guarantee of no anomalies under concurrency and failures.
- Secondary indexes on sharded data: local indexes make reads scatter to all shards; global indexes make writes touch several shards and are usually updated asynchronously.

## 8. Consistency models, CAP and PACELC

A consistency model is a contract: which values may a read return, given the writes that happened? Strong models make a replicated system look like one copy. Weak models allow stale or out-of-order reads in exchange for latency and availability.

### From strongest to weakest (the ones you need for interviews)

- **Linearizability (strong consistency).** Once a write is acknowledged, every later read, from any client, sees it or something newer. The system behaves as if there were one copy. Required for things like "only one person gets the last seat" or leader election.
- **Read-your-writes.** A client always sees its own earlier writes. Other clients may still see old data. Example: after booking, you see the booking on your "my bookings" page.
- **Monotonic reads.** A client never sees time go backwards. Without it, refreshing a page may hit a lagging replica and the booking disappears, then reappears.
- **Eventual consistency.** If writes stop, all replicas converge on the same value eventually. It says nothing about how stale a read can be meanwhile.

Read-your-writes and monotonic reads are "session guarantees". You get them cheaply by routing a user's reads to the leader for a short time after they write, by pinning a user to one replica, or by passing a version token ("read at least version 1234"). MongoDB offers causally consistent sessions for this; DynamoDB offers `ConsistentRead=True` on the base table.

### CAP, stated correctly

CAP says: when a network partition splits replicas, a system must choose between consistency (linearizable reads) and availability (every non-failed node answers). Partitions are not optional in a distributed system, so the real choice is what happens during one.

- **CP behaviour:** the minority side refuses requests (errors or timeouts) to avoid returning stale data. Example: a MongoDB replica set where the old primary steps down when it loses the majority.
- **AP behaviour:** every side keeps answering, possibly with stale or conflicting data, and reconciles later. Example: Cassandra at consistency level ONE.

Common mistakes: "pick two of three" (you cannot opt out of P), calling a single-node Postgres "CA" (it is simply not distributed), and using CAP to describe normal operation. CAP says nothing about the 99.9% of the time when the network is healthy.

### PACELC: the trade-off you live with every day

PACELC, proposed by Daniel Abadi, adds the missing half. If there is a Partition, choose Availability or Consistency; Else (normal operation), choose Latency or Consistency. Even with a healthy network, a strongly consistent read or write must wait for coordination between replicas, which costs latency.

| System (typical config) | During partition | Normal operation | Label |
| --- | --- | --- | --- |
| Cassandra, Riak, Dynamo-style at low CL | Availability | Latency | PA/EL |
| Single-leader with synchronous commit, consensus systems | Consistency | Consistency | PC/EC |
| MongoDB (Abadi's classification) | Availability | Consistency | PA/EC |
| DynamoDB | Per request: eventual reads favour latency; `ConsistentRead` favours consistency |  | Tunable |

Tunable systems move along this spectrum per query, which is the useful interview point: consistency is a per-operation decision, not a database-wide label.

### Capstone: what needs strong consistency, and why

| Data | Needs | Reason | Where it lives |
| --- | --- | --- | --- |
| Seat inventory (`seats_left`, seat holds) | Strong (linearizable, atomic check-and-decrement) | Two concurrent bookings must never both take the last seat; overselling costs money and trust | PostgreSQL leader, in a transaction |
| Booking records | Strong on write; read-your-writes for the booking user | Must commit atomically with the seat decrement; user expects to see it immediately | PostgreSQL |
| Payment / idempotency keys | Strong | A retried request must not book or charge twice | PostgreSQL unique constraint |
| Event details (title, venue) | Eventual is fine for reads; strong on edit | A few seconds of stale description harms nobody | Postgres, cached in Redis |
| "Seats left" shown on the event page | Eventual | It is a hint; the booking path re-checks atomically | Redis cache with short TTL |
| Notifications (`booking.created` consumer) | Eventual, at-least-once | Delay is acceptable; duplicates handled by idempotent consumer | Kafka + worker |
| Leaderboard / popular events | Eventual | Approximate ranking is fine | Redis sorted set |
| Search index | Eventual | Seconds of lag are normal for search | Elasticsearch/OpenSearch or Postgres full-text |

The rule: data that protects an invariant (no overselling, no double charge) needs strong consistency at the point of write. Data that only informs a human or another system can lag.

**Pitfalls**

- Saying "MongoDB is CP, Cassandra is AP" as if it were fixed. Both depend on configuration (write/read concern, consistency level).
- Confusing ACID consistency (constraints hold) with CAP consistency (linearizability). Different C's.
- Showing "seats left" from a cache and then trusting that number on the booking path.
- Forgetting session guarantees: eventual consistency without read-your-writes produces "my booking vanished" support tickets.

## 9. Choosing SQL vs NoSQL

Default to PostgreSQL, and add a NoSQL store when a specific access pattern or scale requirement justifies the extra system. Every new database adds backups, monitoring, failover drills and a consistency boundary between stores.

### Decision checklist

Ask these in order. A "yes" pushes toward the option in the right column.

| Question | If yes |
| --- | --- |
| Do invariants span several records (balances, inventory, uniqueness)? | Relational, or a NoSQL store with transactions used deliberately |
| Will people ask new, unplanned questions of the data (reporting, admin filters)? | Relational |
| Is the data highly connected with many-to-many joins? | Relational; graph if multi-hop traversal is the main query |
| Are the access patterns few, known and stable? | Key-value or wide-column becomes viable |
| Does write volume or data size exceed what one primary can handle, even after tuning? | Wide-column (Cassandra/ScyllaDB) or DynamoDB |
| Do records vary a lot in shape, and are they read as a whole? | Document store, or Postgres `jsonb` first |
| Do you need sub-millisecond reads of hot data? | Redis in front of the source of truth |
| Do you need multi-region active-active writes? | Leaderless or multi-leader store, with a conflict strategy |
| Is the team small, and is ops time scarce? | Fewer systems; managed services |

### Polyglot persistence

Polyglot persistence means using several stores, each for what it does best, with one designated source of truth per piece of data. Your capstone already does this: Postgres for events and bookings, Redis for caching and rate limiting, Kafka as the durable log of `booking.created`. The hard part is keeping derived stores in sync. The safe pattern: write to the source of truth, publish an event (ideally via a transactional outbox so the event and the row commit together), and let consumers update caches, search indexes and analytics. Derived stores can then be rebuilt from the log.

### Interview language

Phrases that show judgment:

- "I'd start with the access patterns and the invariants, then pick the store."
- "Postgres is the source of truth for anything with an invariant; derived views are eventually consistent and rebuildable."
- "DynamoDB fits when access patterns are known and scale is large; the cost is that new queries need new indexes or tables."
- "CAP only applies during a partition. In normal operation the trade-off is latency vs consistency, which is PACELC."
- "I'd make consistency a per-operation choice: strong for the booking write, eventual for the event list."
- "Before sharding, I'd exhaust indexes, read replicas, caching and vertical scaling."

Phrases to avoid: "NoSQL is faster", "NoSQL scales, SQL doesn't", "MongoDB has no schema", "we pick two of CAP".

**Pitfalls**

- Choosing a database from a benchmark instead of from your queries.
- Two sources of truth for the same fact, updated by dual writes without an outbox. One will drift.
- Adding a store "for later scale" that the team cannot operate today.

## Apply it to the capstone

This week's build tasks are design write-ups, not code. Write each one yourself first (half a page each is enough), then compare against the sketches below. The sketches are one reasonable answer, not the only one.

### Task 1: Where each NoSQL family would fit in this app

Hint: for each family, name one concrete piece of capstone data, the query it serves, and why Postgres is worse at it. Then say whether you would actually add it now.

| Family | Capstone use | Why it fits | Add it now? |
| --- | --- | --- | --- |
| Key-value (Redis) | Event-page cache, "seats left" hint, rate limiting on `POST /bookings`, short seat holds with TTL, idempotency keys for the API | Microsecond reads, TTL, atomic `INCR`/`SET NX` | Yes, already in the stack |
| Document (MongoDB) | Event listings with varying attributes per category (concerts vs workshops), organiser-defined custom fields | Read as a whole, shape varies | No: Postgres `jsonb` covers it |
| Wide-column (Cassandra) | Booking/activity history and notification log at very high write volume, partitioned by user with time buckets | Cheap writes, ordered per-user reads | Only at very large scale |
| Graph (Neo4j) | "Users who booked this also booked" recommendations, friends attending | Multi-hop traversals | No: batch recommendations in SQL first |
| Key-value (DynamoDB) | Whole booking service if run serverless on AWS with known patterns | Managed scale, conditional writes | Only if the platform is AWS-native |

A strong write-up ends with: "Postgres remains the source of truth for events, users, seats and bookings; Redis is the only NoSQL store justified today."

### Task 2: Event + bookings as MongoDB documents vs the SQL schema

Hint: draw both options from section 4, then answer four questions. How is "no overselling" enforced? How do you list a user's bookings? What happens at 20,000 bookings for one event? What gets duplicated and how is it kept fresh?

| Concern | SQL schema | MongoDB embedded | MongoDB referenced |
| --- | --- | --- | --- |
| No overselling | Transaction: `UPDATE events SET seats_left = seats_left - n WHERE id = ? AND seats_left >= n`, then `INSERT` booking | One atomic update: `$inc` seats and `$push` booking with filter `seats_left >= n` | Conditional `find_one_and_update` on event + insert booking, inside a transaction |
| One booking per user per event | `UNIQUE (event_id, user_id)` | Filter `bookings.user_id: {$ne: user}` in the same update | Unique compound index on `(event_id, user_id)` |
| Bookings by user | Index on `bookings(user_id, created_at)` | Multikey index on `bookings.user_id`, returns whole events | Index `(user_id, created_at)` on bookings |
| Large event | Fine | Unbounded array, hot document, 16 MiB ceiling | Fine |
| Duplication | None | `user_name` inside each booking | `event_title` in bookings (extended reference) |

Expected conclusion: referenced documents are the right MongoDB model, and they end up close to the SQL schema. The point of the exercise is to see that the embedded model's atomicity is attractive but its growth is not.

### Task 3: DynamoDB keys for "bookings by user" and "bookings by event"

Hint: list the access patterns first. Decide what the base table's partition key is, and serve the other pattern with a GSI. Then say what is eventually consistent.

Sketch (single table):

| Item | PK | SK | GSI1PK | GSI1SK |
| --- | --- | --- | --- | --- |
| Event | `EVENT#<event_id>` | `META` |  |  |
| Booking | `EVENT#<event_id>` | `BOOKING#<user_id>` | `USER#<user_id>` | `<created_at ISO>#<event_id>` |

- Bookings by event: `Query PK = EVENT#evt_42 AND begins_with(SK, "BOOKING#")`. Strongly consistent if needed.
- Bookings by user: `Query GSI1 where GSI1PK = USER#usr_7`, newest first. Eventually consistent: a fresh booking may appear a moment late.
- Booking: `TransactWriteItems` with `seats_left >= :n` on the event and `attribute_not_exists(SK)` on the booking.
- Hot partition note: a big on-sale concentrates writes on one event PK (1,000 write units per second per partition). Mention counter sharding or a queue.

Alternative worth mentioning: make the user the base-table PK and the event the GSI. Choose based on which read must be strongly consistent. Usually the organiser and the booking path care about the event side, so the event is the base key.

### Task 4: Which data truly needs strong consistency, and why

Hint: for every piece of data, ask "what breaks if a read is 2 seconds stale?" If the answer is "money, inventory or a duplicate", it needs strong consistency at write time.

Use the table in section 8 as your answer key. The core argument in three sentences:

1. Seat inventory and bookings protect an invariant (sold seats never exceed capacity), so the check and the decrement must be atomic and linearizable: one Postgres transaction with a conditional update or row lock.
2. The `booking.created` event is published after commit (via an outbox) and consumers are idempotent, so notifications can be eventual and at-least-once.
3. Cached "seats left", leaderboards and search are derived views; they may lag, as long as the booking path never trusts them.

Bonus point for the write-up: name the session guarantee you want for the user who just booked (read-your-writes), and how you would provide it (read from the primary for that request, or return the booking in the POST response and render from it).

## Check yourself

Answer out loud or in writing before opening the answers. For more practice, work through sections 17 to 23 of the [Database Interview Prep Guide](https://github.com/aasthas2022/SDE-Interview-and-Prep-Roadmap/blob/main/Databases/database-interview-prep-guide.md) in the roadmap repo (NoSQL types, CAP/BASE, replication, sharding, SQL vs NoSQL, Postgres vs DynamoDB, keys and idempotency).

1. Why do many NoSQL databases drop joins and multi-row transactions? What problem does that solve?
2. Explain the write path of an LSM-tree. Why are writes cheap, and where is the cost paid instead?
3. What does a bloom filter answer, and why does it help reads in an LSM-tree but not range scans?
4. In MongoDB, would you embed bookings inside the event document? Give two reasons for your answer.
5. Design DynamoDB keys so that both "bookings by event" and "bookings by user" are single queries. Which of the two is eventually consistent?
6. How do you prevent overselling in DynamoDB without reading the item first?
7. What is a hot partition? Give a capstone example and two mitigations.
8. With N = 3 replicas, which R and W give read-after-write overlap? Why is that still not the same as linearizability?
9. Why does `hash(key) mod N` sharding hurt when adding a node, and how does consistent hashing fix it?
10. State CAP correctly. What does PACELC add?
11. Define read-your-writes and monotonic reads. How would you give a user read-your-writes after booking?
12. An interviewer asks: "Should the booking service move from Postgres to MongoDB for scale?" How do you answer?

## Answers

1. Joins and multi-row transactions need coordination when rows live on different machines: network round trips, locks, two-phase commit. Limiting operations to one key or one partition lets the system scale out by adding nodes with little coordination. You pay by denormalising and enforcing cross-record invariants yourself.
2. Append to the commit log, insert into the sorted memtable, acknowledge. Full memtables flush to immutable SSTables; compaction merges them later. Writes are sequential and need no read. The cost moves to reads (several files to check) and to compaction (data rewritten several times: write amplification over time).
3. "Is this key definitely absent from this file?" A no lets the read skip the SSTable. A range scan wants all keys between two bounds, which a membership test cannot answer, so every overlapping file must still be read.
4. No. Bookings are unbounded (document growth toward 16 MiB, ever-larger rewrites), the event document becomes a hot spot for every booking, and "my bookings" is queried by user. Embed only bounded, owned data such as venue or ticket tiers.
5. Base table: `PK = EVENT#id`, `SK = BOOKING#user_id`; GSI1: `GSI1PK = USER#user_id`, `GSI1SK = created_at#event_id`. Bookings by user (the GSI query) is eventually consistent, because GSIs are updated asynchronously and do not support strongly consistent reads.
6. Put the check in the write: `UpdateItem` with `SET seats_left = seats_left - :n` and `ConditionExpression seats_left >= :n`. If you also write a booking item, wrap both in `TransactWriteItems`, adding `attribute_not_exists(SK)` on the booking, and pass a `ClientRequestToken` for idempotent retries.
7. A partition receiving more traffic than its share, up to the per-partition ceiling (1,000 write units per second in DynamoDB). Example: one event item during a big on-sale. Mitigations: shard the counter across N items, queue booking requests, cache reads of the event.
8. Any R + W > 3, typically R = 2, W = 2. It is not linearizable because concurrent writes, partial write failures, sloppy quorums and clock-based last-write-wins can still let different readers observe different orders.
9. Changing N changes `hash mod N` for almost every key, so nearly all data moves. Consistent hashing places nodes on a ring; a new node takes only the arc before it, roughly 1/N of the data, and vnodes spread that load across many peers.
10. During a network partition, a replicated system must choose between returning consistent (linearizable) data and staying available on every node. PACELC adds that, even without a partition, you trade latency against consistency, because strong consistency needs coordination between replicas on every operation.
11. Read-your-writes: a client always sees its own prior writes. Monotonic reads: a client never sees older data after seeing newer. For the booking user: read from the primary (or `ConsistentRead=True`) for a short window after their write, pin their session to one replica, or render the booking from the POST response.
12. Ask what is failing first: write throughput, data size, latency, or schema friction. Bookings need atomic seat decrements and uniqueness, which Postgres does natively. I would exhaust indexes, connection pooling, read replicas, Redis caching and partitioning by event before moving, and would offload derived workloads (history, search, notifications) through Kafka. MongoDB could work with careful modelling and transactions, but it is not a scale fix by itself.

## Sources

Books and papers

- [Designing Data-Intensive Applications, 2nd ed., ch. 4 "Storage and Retrieval"](https://www.oreilly.com/library/view/designing-data-intensive-applications/9781098119058/ch04.html) (Kleppmann and Riccomini; also lists ch. 6 "Replication")
- [Designing Data-Intensive Applications, 2nd ed., ch. 7 "Sharding"](https://www.oreilly.com/library/view/designing-data-intensive-applications/9781098119058/ch07.html)
- [Abadi, "Consistency Tradeoffs in Modern Distributed Database System Design" (PACELC)](https://cs.umd.edu/~abadi/papers/abadi-pacelc.pdf)

MongoDB and PyMongo

- [Motor documentation: deprecation notice and dates](https://motor.readthedocs.io/en/latest/)
- [Migrate from Motor to PyMongo Async](https://mongodb.com/docs/languages/python/pymongo-driver/current/motor-async-migration)
- [PyMongo driver documentation (current)](https://www.mongodb.com/docs/languages/python/pymongo-driver/current/)
- [PyMongo async `client_session` API (sessions and transactions)](https://pymongo.readthedocs.io/en/4.13.0/api/pymongo/asynchronous/client_session.html)
- [MongoDB: Embedded data versus references](https://www.mongodb.com/docs/manual/data-modeling/concepts/embedding-vs-references/)
- [MongoDB limits and thresholds](https://www.mongodb.com/docs/manual/reference/limits/)

DynamoDB

- [TransactWriteItems API reference](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)
- [Condition expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html)
- [Global secondary indexes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html)
- [Best practices for designing partition keys](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html)

Cassandra

- [Cassandra architecture: Dynamo (consistency levels, consistent hashing, replication)](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html)
- [Cassandra storage engine (commit log, memtables, SSTables)](https://cassandra.apache.org/doc/latest/cassandra/architecture/storage-engine.html)

PostgreSQL

- [PostgreSQL 18: JSON types and jsonb indexing](https://www.postgresql.org/docs/current/datatype-json.html)

Self-check

- [SDE Interview and Prep Roadmap: Database Interview Prep Guide](https://github.com/aasthas2022/SDE-Interview-and-Prep-Roadmap/blob/main/Databases/database-interview-prep-guide.md) (sections 17 to 23)
