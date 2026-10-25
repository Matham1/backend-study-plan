# Study Notes — Week 4: Redis in Depth

Oct 23, 2026 · @Mathew Matholomew

After this week you will know why a Redis command is atomic, which data type fits which job, and when to reach for a pipeline, a transaction or a Lua script. You will be able to add caching, a sliding-window rate limiter, expiring seat holds and idempotent booking creation to the event-booking API, and explain what each one costs if Redis crashes or fails over. Postgres stays the source of truth throughout; Redis makes the system fast and polite, not correct.

## 1. What Redis is and how it executes commands

Redis is a server that keeps data structures in RAM and lets clients run commands on them over TCP. It is not a key-value blob store: each key holds a typed structure (string, hash, list, set, sorted set, stream, and more), and the commands operate on that structure server-side. You send `ZINCRBY leaderboard 1 event:42`; you never fetch, modify and write back the whole leaderboard.

### One thread runs the commands

The core of Redis is an event loop. One main thread takes a parsed command, executes it against the in-memory data, and produces the reply. Only then does it look at the next command. Two consequences follow:

- **Every single command is atomic.** While `INCR seats:sold` runs, no other client's command can touch any key. There is no lock inside Redis because there is no concurrency to lock against.
- **One slow command stalls everyone.** `KEYS *` on 10 million keys, `SMEMBERS` on a huge set, or a long Lua script blocks all other clients for its duration. Big-O in the command docs matters.

Why single-threaded? Most commands touch a few bytes of RAM and finish in well under a microsecond. The real cost is network I/O and system calls, not CPU. A single thread also avoids lock contention and keeps the code simple.

### I/O threads (Redis 6+, reworked in 8.0)

Reading sockets, parsing requests and writing replies can be spread across extra threads with the `io-threads` setting. In Redis 8.0 the implementation was rewritten: the main thread assigns each client to an I/O thread, that thread reads and parses the request, the main thread executes it, and the I/O thread writes the reply back. The default is `io-threads 1` (off). Command execution remains on one thread, so the atomicity guarantee above still holds. Background threads also exist for things like lazy freeing (`UNLINK`) and fsync, but they never run your commands.

```text
# redis.conf on a 4+ core box serving many clients
io-threads 4
```

For the capstone you will not need this. Turn it on only when profiling shows the main thread saturated on network I/O.

### Latency profile

A typical round trip to Redis in the same data centre or Docker network costs roughly 0.1 to 0.5 ms, and almost all of that is network, not execution. Two lessons:

1. Cutting round trips (pipelines, scripts, multi-key commands) helps more than anything else.
2. Measure with `redis-cli --latency` and look for slow commands with `SLOWLOG GET 10`.

```bash
redis-cli --latency -h localhost        # continuous min/avg/max in ms
redis-cli SLOWLOG GET 5                 # recent commands over slowlog-log-slower-than (microseconds)
redis-cli INFO memory | grep used_memory_human
```

### Licensing and the landscape (as of October 2026)

- Up to 7.2, Redis was BSD-3 licensed. In 2024, versions 7.4.x moved to a dual RSALv2 / SSPLv1 licence, which is not OSI open source.
- Redis 8.0 (2025) added AGPLv3 as a third option, so Redis Open Source 8.x is tri-licensed (RSALv2, SSPLv1 or AGPLv3). The latest line at the time of writing is 8.10.
- **Valkey** is a fork of the last BSD-licensed Redis (7.2.4), hosted under the Linux Foundation, still BSD. It is wire-compatible for the commands used in this course and has its own 8.x and 9.x releases.
- Redis 8 ships modules that used to be separate (JSON, time series, query engine, probabilistic structures) in the open-source build.

For learning and for this capstone, either `redis:8` or `valkey/valkey:8` in Docker Compose works. Everything below sticks to commands both support, and calls out the few that are Redis 8.4+ only.

### Pitfalls

- Assuming *sequences* of commands are atomic. Each command is; a GET followed by a SET from Python is not.
- Running O(N) commands (`KEYS`, `FLUSHALL`, `HGETALL` on a big hash) in production paths. Use `SCAN` for iteration.
- Treating Redis as "free" latency. 20 sequential calls per request is 20 round trips.
- Expecting `io-threads` to speed up a slow Lua script. Execution is still single-threaded.

## 2. Data types and when to use each

Pick the type by the operation you need to be cheap and atomic, not by how the data looks. Each type has commands that change it in place, so the right choice usually removes a read-modify-write from your Python code.

| Type | Shape | Typical commands | Use it for | Cost notes |
| --- | --- | --- | --- | --- |
| String | bytes up to 512 MB | `GET`, `SET ... NX PX`, `INCR`, `INCRBY`, `MGET` | cached JSON, counters, locks, flags | `INCR` on a missing key starts from 0 |
| Hash | field -> value map | `HSET`, `HGET`, `HINCRBY`, `HGETALL` | an object with fields you update one at a time | small hashes are packed (listpack) and very compact |
| List | ordered, push/pop at ends | `LPUSH`, `RPOP`, `BLMOVE`, `LRANGE` | simple queues, recent-N lists | index access in the middle is O(N) |
| Set | unique members | `SADD`, `SISMEMBER`, `SCARD`, `SINTER` | "has this user booked event X", tags | membership O(1) |
| Sorted set | unique members with a float score | `ZADD`, `ZINCRBY`, `ZRANGE ... REV`, `ZREMRANGEBYSCORE` | leaderboards, sliding windows, delayed jobs | O(log N) updates |
| Stream | append-only log of entries with IDs | `XADD`, `XREADGROUP`, `XACK`, `XTRIM` | durable-ish event log with consumer groups | trim it or it grows forever |

### Strings and counters

A string is the workhorse. `INCR` parses the value as a 64-bit integer, adds one and stores it, all in one atomic step. That is why counters never lose updates in Redis even with 100 concurrent clients.

```bash
SET event:42:views 0
INCR event:42:views            # (integer) 1
INCRBY event:42:views 10       # (integer) 11
SET cache:event:42 '{"id":42,"title":"Jazz night"}' EX 300
```

### Hashes

A hash stores one object's fields under one key. You can update a single field (`HINCRBY event:42:stats bookings 1`) without rewriting the rest. Since Redis 7.4 individual hash fields can carry their own TTL (`HEXPIRE`), and Redis 8.0 added `HSETEX` / `HGETEX` / `HGETDEL`. These are newer than the rest of this list; check your server version before relying on them.

### Sorted sets: leaderboards and time windows

A sorted set keeps members ordered by score in a skip list plus a hash. You get O(log N) updates and cheap range reads by rank or by score. Two capstone uses:

- **Most-booked events:** score = number of bookings, member = event id.
- **Sliding window:** score = timestamp in ms, so `ZREMRANGEBYSCORE key -inf <now - window>` drops old entries and `ZCARD` counts what is left.

```python
from redis.asyncio import Redis

LEADERBOARD = "leaderboard:bookings"

async def record_booking(r: Redis, event_id: int, seats: int) -> None:
    await r.zincrby(LEADERBOARD, seats, f"event:{event_id}")

async def top_events(r: Redis, n: int = 10) -> list[tuple[str, float]]:
    # highest score first; returns [(member, score), ...]
    return await r.zrange(LEADERBOARD, 0, n - 1, desc=True, withscores=True)
```

### Streams

A stream is an append-only log where each entry has an ID like `1729690000000-0` and a small field map. Consumer groups give each entry to one consumer in the group and track acknowledgements (`XACK`), much like a Kafka consumer group in miniature. In the capstone Kafka does this job, so treat streams as "good to know" (section 8 compares them with Pub/Sub).

### Probabilistic types

Redis 8 Open Source includes the former RedisBloom structures: Bloom and Cuckoo filters, Count-min sketch, Top-k and t-digest. A Bloom filter answers "definitely not seen" or "probably seen" in a fixed amount of memory (`BF.RESERVE`, `BF.ADD`, `BF.EXISTS`). Valkey ships Bloom as a separate module instead. You do not need these for the capstone.

### Key naming

Use colon-separated, lower-case names that read from general to specific, and put the id in a predictable place:

```text
cache:event:42                 # cached GET /events/42 response
hold:{event:42}:seat:A7        # seat hold; {event:42} is a cluster hash tag
rl:{ip:10.0.0.5}               # rate-limit window for one client
idem:{user:7}:3f1c...          # idempotency record
leaderboard:bookings
```

A prefix per feature lets you `SCAN MATCH cache:*` during debugging and lets you reason about memory per feature. Keep keys short but readable; the key name is stored once per key.

### TTL semantics you must know

- `EXPIRE key 60` sets a deadline; `TTL` returns seconds left, `-1` for no TTL, `-2` if the key does not exist.
- Commands that *overwrite* the whole value clear the TTL. A plain `SET` removes it unless you pass `KEEPTTL`. Commands that *modify* the value (`INCR`, `HSET`, `LPUSH`, `ZADD`) keep it.
- `RENAME` carries the TTL to the new name.
- Expiry is lazy plus active: a key is deleted when someone touches it after its deadline, and a background cycle samples keys with TTLs and removes expired ones. Memory is reclaimed soon after expiry, not at the exact millisecond. Reads never see an expired key.
- TTLs are stored as absolute Unix timestamps, so they survive restarts and replicate correctly.

I checked these on a local server: after `SET k 1 EX 100` then `INCR k`, `TTL k` still returned 100; after a plain `SET k 5` it returned -1.

### Memory considerations

- Every key has overhead (dozens of bytes) beyond its value. Millions of tiny keys cost more than one hash holding the same fields.
- Small hashes, lists, sets and sorted sets use a compact listpack encoding until they exceed thresholds such as `hash-max-listpack-entries` (default 512). `OBJECT ENCODING key` shows which you have.
- `MEMORY USAGE key` estimates bytes for one key; `INFO memory` shows totals and fragmentation.
- Anything that is a cache should have a TTL, and the server should have `maxmemory` plus an eviction policy (section 4).

### Pitfalls

- Forgetting that `SET` drops the TTL, then wondering why a cache entry never expires.
- Storing a big JSON blob in a string and rewriting it to change one field. Use a hash if fields change independently.
- Unbounded collections: a sorted set or stream that is never trimmed is a memory leak.
- Using `KEYS pattern` in application code. It is O(N) and blocks the server; use `SCAN` or keep an index set.
- Float scores in sorted sets: integers above 2^53 lose precision.

## 3. Atomicity tools: pipelines, transactions, scripts

One command is atomic. The moment you need *several* commands to behave as one, you have three tools, and they solve different problems. Pipelines save round trips. MULTI/EXEC groups writes so nothing interleaves. Lua scripts let you read, decide and write in one atomic step.

| Tool | Saves round trips | No interleaving | Can branch on a value it read | Rollback on error |
| --- | --- | --- | --- | --- |
| Pipeline (`transaction=False`) | yes | no | no | no |
| `MULTI` / `EXEC` | yes (when pipelined) | yes | no | no |
| `WATCH` + `MULTI` / `EXEC` | partly | yes, or aborts | yes, in the client, with retries | no |
| Lua `EVAL` / `FCALL` | yes | yes | yes, on the server | no |

### Pipelining

A pipeline is a client-side trick: send N commands without waiting for each reply, then read N replies. One network round trip instead of N. Other clients' commands can still run between yours on the server, so a pipeline is not atomic.

```python
async def bump_views(r: Redis, event_id: int) -> int:
    key = f"event:{event_id}:views"
    async with r.pipeline(transaction=False) as pipe:
        pipe.incr(key)
        pipe.expire(key, 86_400)
        views, _ = await pipe.execute()
    return views
```

In redis-py, `r.pipeline()` defaults to `transaction=True`, which wraps the batch in MULTI/EXEC. Pass `transaction=False` when you only want fewer round trips.

### MULTI / EXEC

`MULTI` starts queuing; each following command replies `QUEUED`; `EXEC` runs the queue as one uninterrupted block. No other client's command runs in the middle.

There is **no rollback**. If a queued command fails at run time (say `LPOP` on a string), the others still execute and keep their effects; `EXEC` returns a mix of results and errors. Only errors caught while queuing (a syntax error, unknown command) make the whole `EXEC` refuse to run. The design assumes runtime errors are programming bugs, not conditions to recover from.

```bash
MULTI
SET a abc
LPOP a          # will fail at EXEC: WRONGTYPE
SET b 1
EXEC
# 1) OK
# 2) (error) WRONGTYPE ...
# 3) OK          <- b is set anyway
```

The bigger limitation: inside MULTI you cannot read a value and decide what to write, because nothing executes until `EXEC`.

### WATCH: optimistic locking

`WATCH key` before `MULTI` turns the transaction into compare-and-set. If any watched key changes before `EXEC` (another client's write, or since 6.0.9 also expiry or eviction), `EXEC` returns null and nothing runs. You retry. redis-py raises `WatchError`.

```python
from redis.exceptions import WatchError

async def reserve_counter(r: Redis, event_id: int, seats: int, capacity: int) -> bool:
    key = f"event:{event_id}:reserved"
    async with r.pipeline() as pipe:
        for _ in range(5):                      # bounded retries
            try:
                await pipe.watch(key)
                current = int(await pipe.get(key) or 0)   # immediate mode after watch
                if current + seats > capacity:
                    await pipe.unwatch()
                    return False
                pipe.multi()
                pipe.incrby(key, seats)
                await pipe.execute()
                return True
            except WatchError:
                continue
    return False
```

This works, but under contention many clients retry and waste round trips. It also costs at least two round trips per attempt. For hot keys, a script is better.

### Lua scripts: atomic read-modify-write

`EVAL` sends a Lua script that runs inside the server. While it runs, nothing else does, so it can read, branch and write as if it were one command. The same capacity check becomes:

```lua
-- KEYS[1] = reserved counter, ARGV[1] = seats, ARGV[2] = capacity
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local seats = tonumber(ARGV[1])
if current + seats > tonumber(ARGV[2]) then
  return 0
end
redis.call('INCRBY', KEYS[1], seats)
return 1
```

Rules that matter:

- **Declare every key in `KEYS`**, values in `ARGV`. Redis Cluster uses the declared keys to route the script, and they must all hash to the same slot. Do not build key names inside the script.
- **Script cache.** Redis caches each script by its SHA1. `EVALSHA <sha>` runs it without resending the source; if the cache was flushed (restart, failover) you get `NOSCRIPT` and must resend. redis-py's `register_script` handles this for you.
- **No rollback here either.** I verified that a script which runs `SET x` and then fails on `INCR` of a non-number leaves `x` written. Validate first, write last.
- **Keep scripts short.** A script blocks the whole server. After `busy-reply-threshold` (default 5000 ms, formerly `lua-time-limit`) Redis starts answering other clients with `BUSY`, and `SCRIPT KILL` only works if the script has not written yet.
- `redis.call` raises on error and aborts the script; `redis.pcall` returns the error as a value so you can handle it.
- Since Redis 5 scripts replicate by effects (the writes they made), so calling `TIME` inside a script is fine.

### FUNCTION: named, persisted scripts (Redis 7+)

Functions are scripts loaded once as a library and called by name with `FCALL`. Unlike the `EVAL` cache, libraries are persisted in RDB/AOF and replicated, so there is no `NOSCRIPT` dance after a failover.

```lua
#!lua name=booking

local function release_hold(keys, args)
  if redis.call('GET', keys[1]) == args[1] then
    return redis.call('DEL', keys[1])
  end
  return 0
end

redis.register_function('release_hold', release_hold)
```

```bash
cat booking.lua | redis-cli -x FUNCTION LOAD REPLACE
redis-cli FCALL release_hold 1 hold:{event:42}:seat:A7 user:7
```

For the capstone, `register_script` from Python is simpler: the scripts live in your repo next to the code that calls them. Functions make sense when several services share the same server-side logic.

### Pitfalls

- Calling a pipeline "a transaction". With `transaction=False` it is just batching.
- Expecting MULTI/EXEC to undo earlier commands when a later one fails.
- Unbounded `WATCH` retry loops under contention.
- Generating a new script string per call (with values baked in). Each variant fills the script cache; pass values via `ARGV`.
- Reading keys in a script that were not passed in `KEYS`. Works on one node, breaks in Cluster.

## 4. Caching patterns

For the capstone, use cache-aside with a TTL and delete-on-write invalidation. It is the simplest pattern that stays correct when Redis is down, empty or evicting. The other patterns exist for different trade-offs, and you should be able to explain them.

### Cache-aside (lazy loading)

The application owns both stores. On a read it checks Redis first; on a miss it loads from Postgres, writes the result into Redis with a TTL, and returns it. On a write it updates Postgres and then deletes the cache key, so the next read reloads fresh data.

```python
import json
from redis.asyncio import Redis
from redis.exceptions import RedisError

CACHE_TTL_S = 300

async def get_event_cached(r: Redis, event_id: int) -> dict | None:
    key = f"cache:event:{event_id}"
    try:
        if (raw := await r.get(key)) is not None:
            return json.loads(raw)
    except RedisError:
        pass                                    # cache down -> fall through to DB
    event = await load_event_from_db(event_id)  # your SQLAlchemy query
    if event is not None:
        try:
            await r.set(key, json.dumps(event), ex=CACHE_TTL_S)
        except RedisError:
            pass
    return event

async def update_event(r: Redis, event_id: int, patch: dict) -> dict:
    event = await update_event_in_db(event_id, patch)   # commit first
    await r.delete(f"cache:event:{event_id}")          # then invalidate
    return event
```

Why *delete* instead of *set* on write? Two concurrent PATCHes can commit in order A, B but write the cache in order B, A, leaving A's stale data cached until the TTL. Deleting is idempotent and order-free: whoever reads next reloads the committed state. A small race remains (a reader loads old data, a writer commits and deletes, then the reader writes the old data back). The TTL bounds how long that can last, which is why every cache entry needs one.

&#91;embedded content: cache-aside · read path and write path\]

The read path only touches Postgres on a miss; the write path never writes the cache, it only deletes the key after the commit.

### The other patterns

| Pattern | Read path | Write path | Strength | Weakness |
| --- | --- | --- | --- | --- |
| Cache-aside | app checks cache, loads DB on miss | app writes DB, deletes key | simple; cache can fail or be flushed safely | first read after a write is slow; small stale window |
| Read-through | cache layer loads from DB on miss | (paired with one below) | callers see one interface | needs a library or proxy that knows your DB |
| Write-through | read from cache | write cache and DB together, synchronously | cache is always warm and fresh | every write pays both; caches data nobody reads |
| Write-behind (write-back) | read from cache | write cache now, flush to DB later in batches | very fast writes, absorbs spikes | data loss if cache dies before flush; DB lags |

Write-behind is a poor fit for bookings: money and seats must be in Postgres before you answer 201. It suits counters and analytics, such as view counts flushed every minute.

### Choosing a TTL

Ask how stale the data may be, and how expensive a miss is. Event details (title, venue, description) change rarely, so 5 to 15 minutes is fine with delete-on-write. Seat availability changes every second, so either do not cache it or cache it for 1 to 2 seconds and accept that the booking endpoint re-checks in Postgres anyway. Negative results ("event 999 does not exist") can be cached briefly, say 30 seconds, to stop repeated misses hammering the DB.

### Invalidation strategies

- **Delete on write** (above). Precise, but you must find every write path, including admin tools and migrations.
- **TTL only.** No invalidation code at all; you accept staleness up to the TTL.
- **Versioned keys.** Store a version counter (`event:42:v`) and build cache keys like `cache:event:42:v7`. Bumping the counter makes old entries unreachable; they expire on their own. Handy when one change invalidates many derived keys (lists, search results).
- **Event-driven.** A consumer of your Kafka `event.updated` topic deletes keys. Useful when other services write the data.

### Cache stampede (thundering herd)

A popular key expires. A thousand concurrent requests miss at the same moment and all run the same expensive query. The DB falls over exactly when traffic peaks. Mitigations, from simplest:

1. **Jittered TTLs.** `ttl = base + random.randint(0, base // 10)`. Keys written together no longer expire together.
2. **Request coalescing (single-flight) in-process.** Keep a dict of `asyncio.Future`s per key so concurrent misses in one worker await a single load. Cheap, but each worker process still loads once.
3. **Rebuild lock in Redis.** On a miss, `SET lock:cache:event:42 <token> NX PX 5000`. The winner loads and fills the cache; losers wait briefly and re-read, or serve a stale copy if you keep one.
4. **Early recomputation.** Refresh before expiry. Store the value with its compute time; each reader recomputes with a probability that rises as expiry nears (the "XFetch" method from Vattani et al., 2015). Or have a background job refresh known-hot keys.
5. **Stale-while-revalidate.** Keep a soft expiry inside the value and a longer hard TTL on the key. After the soft expiry, serve the stale value and trigger one refresh behind a lock.

```python
import asyncio, random, secrets

async def get_with_lock(r: Redis, event_id: int) -> dict | None:
    key, lock = f"cache:event:{event_id}", f"lock:cache:event:{event_id}"
    for _ in range(20):
        if (raw := await r.get(key)) is not None:
            return json.loads(raw)
        token = secrets.token_hex(8)
        if await r.set(lock, token, nx=True, px=5_000):
            try:
                event = await load_event_from_db(event_id)
                ttl = CACHE_TTL_S + random.randint(0, 30)          # jitter
                await r.set(key, json.dumps(event), ex=ttl)
                return event
            finally:
                await release_lock(release_script, lock, token)                 # compare-and-delete, section 6
        await asyncio.sleep(0.05)                                   # someone else is loading
    return await load_event_from_db(event_id)                      # give up waiting, go direct
```

This is a good example of a lock used for **efficiency**: if it fails and two workers load the same row, nothing breaks.

### Serialization

- **JSON** (`json` or `orjson`): readable in `redis-cli`, language-neutral, a bit larger and slower. The right default. With Pydantic, `model.model_dump_json()` and `Model.model_validate_json(raw)`.
- **MessagePack**: smaller and faster, binary, still cross-language.
- **pickle**: avoid. It ties the cache to Python class layouts, and unpickling data someone else wrote can execute code.

Put a schema version in the key or value (`cache:v2:event:42`) so a deploy that changes the shape does not crash on old entries.

### Eviction: what happens when memory is full

Set `maxmemory` and pick `maxmemory-policy`. The default policy is `noeviction`: writes fail with an OOM error once the limit is hit, which is right for a primary datastore and wrong for a pure cache.

| Policy | Evicts from | Pick |
| --- | --- | --- |
| `noeviction` (default) | nothing; writes error | data that must not vanish (holds, idempotency records) |
| `allkeys-lru` | any key, least recently used | a pure cache; the usual choice |
| `allkeys-lfu` | any key, least frequently used | cache with a stable hot set |
| `volatile-lru` / `volatile-lfu` | only keys with a TTL | mixed instance: cache keys have TTLs, other data does not |
| `volatile-ttl` | keys with the shortest remaining TTL | when soon-to-expire means least valuable |
| `allkeys-random` / `volatile-random` | random | uniform access |

Redis 8.6 added `allkeys-lrm` / `volatile-lrm` (least recently *modified*). LRU and LFU are approximated by sampling a few keys (`maxmemory-samples`, default 5) rather than tracking exact order. In the capstone one Redis holds cache, holds, rate-limit windows and idempotency records. Every one of those keys has a TTL, so `volatile-lru` is a defensible choice. In production you would more likely split cache and "state" into separate instances.

### Pitfalls

- Caching without a TTL. Every bug in invalidation then lives forever.
- Updating the cache in the write path instead of deleting it, which races.
- Invalidating before the DB commit. A reader can refill the cache with old data before your transaction lands.
- Letting a Redis outage take down reads. Cache errors should fall back to the DB.
- Caching per-user or per-query results with unbounded key spaces and no `maxmemory`.

## 5. Rate limiting

A rate limiter answers one question per request: has this client used up its budget for the current window? Redis is the natural place for the counter because every API worker shares it and its commands are atomic. The algorithm decides how fair and how memory-hungry the answer is.

| Algorithm | State per client | Accuracy | Bursts | Good for |
| --- | --- | --- | --- | --- |
| Fixed window | 1 counter | edges allow up to 2x the limit | allowed at window start | simple quotas ("1000 per day") |
| Sliding window log | 1 sorted set, one entry per request | exact | none beyond the limit | low limits, login or booking endpoints |
| Sliding window counter | 2 counters | approximate (weighted) | smoothed | high limits where a log costs too much memory |
| Token bucket | 2 numbers (tokens, last refill) | exact for its model | up to bucket capacity, then steady rate | APIs that want short bursts but a steady average |

### Fixed window

Key per client per window: `rl:{ip}:<unix_minute>`. `INCR` it, set `EXPIRE` on first use, reject when the value exceeds the limit. Two commands, so pipeline them, or use `SET key 0 EX 60 NX` followed by `INCR`. The flaw: a client can send the full limit at 12:00:59 and again at 12:01:00, doubling the rate across the boundary.

### Sliding window log (sorted set)

Store one sorted-set member per accepted request, scored by its timestamp in ms. For each new request: drop members older than `now - window`, count the rest, and accept only if the count is below the limit. When rejecting, the oldest remaining entry tells you exactly when a slot frees up, which is your `Retry-After`.

These steps must be atomic. If two requests both count 9 of 10 and both add themselves, you let 11 through. So the whole thing is one Lua script:

```lua
-- KEYS[1] = zset for this client
-- ARGV[1] = limit, ARGV[2] = window in ms, ARGV[3] = unique request id
local t = redis.call('TIME')                          -- server clock, same for every worker
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local used = redis.call('ZCARD', KEYS[1])

if used < limit then
  redis.call('ZADD', KEYS[1], now, now .. ':' .. ARGV[3])   -- member must be unique
  redis.call('PEXPIRE', KEYS[1], window)                   -- idle clients cost nothing
  return {1, limit - used - 1, 0}
end

local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {0, 0, tonumber(oldest[2]) + window - now}         -- ms until a slot frees
```

I ran it locally with limit 5 and a 2 s window: six quick calls returned `[1,4,0] [1,3,0] [1,2,0] [1,1,0] [1,0,0] [0,0,1999]`.

Details worth noticing:

- Using `TIME` inside the script means every worker uses the Redis clock, not its own. Clock skew between API containers no longer matters.
- The member is `timestamp:uuid` because two requests in the same millisecond would otherwise collapse into one member.
- Memory is O(limit) per client. Fine for 100 per minute; wasteful for 10,000 per minute.

### Sliding window counter

Keep a counter for the current fixed window and the previous one. Estimate the sliding count as `previous * (fraction of the previous window still inside the sliding window) + current`. If the window is 60 s and you are 15 s into the current one, the estimate is `prev * 0.75 + cur`. It assumes requests in the previous window were spread evenly, which is usually close enough, and it costs two integers per client.

```lua
-- KEYS[1] = current window counter, KEYS[2] = previous window counter
-- ARGV[1] = limit, ARGV[2] = window ms, ARGV[3] = ms elapsed in current window
local limit, window, elapsed = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local prev = tonumber(redis.call('GET', KEYS[2]) or '0')
if prev * (window - elapsed) / window + cur + 1 > limit then
  return {0, window - elapsed}            -- conservative: wait for the next window
end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], window * 2)  -- must outlive the next window, where it becomes "prev"
return {1, 0}
```

The caller computes `window_index, elapsed = divmod(now_ms, window_ms)` and passes keys `rlc:{ip:1.2.3.4}:<index>` and `...:<index-1>`. The shared hash tag keeps both keys in one cluster slot.

### Token bucket

A bucket holds up to `capacity` tokens and refills at `rate` tokens per second. Each request takes one. You do not need a timer: store the token count and the time of the last update, and on each request add `elapsed * rate` (capped at capacity) before deciding.

```lua
-- KEYS[1] = hash {tokens, ts}; ARGV[1] = capacity, ARGV[2] = tokens per second, ARGV[3] = cost
local capacity, rate, cost = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local t = redis.call('TIME')
local now = tonumber(t[1]) + tonumber(t[2]) / 1e6
local s = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(s[1]) or capacity
local ts = tonumber(s[2]) or now

tokens = math.min(capacity, tokens + (now - ts) * rate)
local allowed, retry_ms = 0, 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil((cost - tokens) / rate * 1000)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate * 1000))  -- full bucket = no state needed
return {allowed, retry_ms}
```

With capacity 3 and rate 1/s, five instant calls gave three allows then two denials with `retry_ms = 1000`; after one second the next call was allowed. Note `tostring`: Lua numbers returned to Redis are truncated to integers, so store fractional state as strings.

### Returning 429 with Retry-After

HTTP 429 Too Many Requests (RFC 6585) is the status. `Retry-After` takes whole seconds (or an HTTP date), so round the script's milliseconds *up*. Many APIs also send `RateLimit-Limit` / `RateLimit-Remaining` style headers; an IETF draft standardises them, but they are optional.

```python
import math, uuid
from fastapi import Request
from fastapi.responses import JSONResponse

async def rate_limit_middleware(request: Request, call_next):
    limiter = request.app.state.sliding_log            # Script from register_script
    client = request.client.host if request.client else "unknown"
    allowed, remaining, retry_ms = await limiter(
        keys=[f"rl:{{ip:{client}}}"], args=[100, 60_000, uuid.uuid4().hex]
    )
    if not allowed:
        return JSONResponse(
            {"detail": "Too many requests"},
            status_code=429,
            headers={"Retry-After": str(max(1, math.ceil(retry_ms / 1000)))},
        )
    response = await call_next(request)
    response.headers["X-RateLimit-Remaining"] = str(remaining)
    return response
```

Decide what happens when Redis is unreachable. For a public API, "fail open" (let the request through and log it) usually beats turning a cache outage into a total outage. For login brute-force protection you might fail closed.

### Pitfalls

- Doing `ZREMRANGEBYSCORE`, `ZCARD`, `ZADD` as three calls from Python. Concurrency lets extra requests through.
- Using each API container's clock. Use Redis `TIME` or accept skew.
- Keying by IP behind a proxy and seeing only the proxy's IP. Trust `X-Forwarded-For` only from your own proxy.
- Forgetting `PEXPIRE`, so every client that ever called you keeps a key forever.
- Returning `Retry-After: 0` from rounding down.

## 6. Distributed locks and short-lived holds

A Redis lock is a key that exists while someone owns a resource and disappears after a timeout. It is great for avoiding duplicate work and for UX features like "these seats are held for you for 10 minutes". It is not a safe guard for correctness on its own; the database must still enforce the invariant.

### Acquiring: one command

```bash
SET lock:payout:42 9f3c1a7e... NX PX 30000
# OK    -> you own it for 30 s
# (nil) -> someone else does
```

- `NX` creates the key only if it does not exist, so exactly one client wins.
- `PX 30000` makes the lock expire if the owner crashes. Without it a dead process holds the lock forever.
- The value is a random token unique to this acquisition. It is how you prove ownership later.

Never use `SETNX` followed by `EXPIRE`: if the process dies between the two, the lock never expires.

### Releasing: compare-and-delete

A plain `DEL` is wrong. Imagine client A takes the lock, stalls for 35 s in a GC pause, the lock expires, client B takes it, then A wakes up and deletes B's lock. The release must delete only if the value is still yours, and that check-then-delete must be atomic:

```lua
-- KEYS[1] = lock key, ARGV[1] = my token
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
```

```python
from redis.commands.core import AsyncScript

RELEASE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""

# once, at startup: release_script = r.register_script(RELEASE_LUA)

async def release_lock(release_script: AsyncScript, key: str, token: str) -> bool:
    return bool(await release_script(keys=[key], args=[token]))
```

Redis 8.4 added `DELEX key IFEQ <value>`, which does the same in one native command. Use the script if you need to support older Redis or Valkey.

### Redlock and the critique

A single Redis node is a single point of failure, and failover does not save you: replication is asynchronous, so a lock written to the primary may not reach the replica before the primary dies. The promoted replica has no lock, and a second client acquires it.

**Redlock** is Redis's proposed fix: run N (typically 5) independent masters, try to take the lock on all of them with a short per-node timeout, and consider it held only if a majority succeeded and the elapsed time is less than the TTL.

Martin Kleppmann's 2016 analysis argues this is the wrong tool for correctness:

- **Process pauses.** A client can be paused (GC, page fault, CPU starvation) after it checks it holds the lock and before it writes. The lease expires, someone else gets the lock, and the paused client writes anyway. No lock service can prevent that by itself.
- **Timing assumptions.** Redlock's safety depends on bounded network delay, bounded pauses and clocks that do not jump. Real systems violate these occasionally.
- **Fencing tokens.** The robust fix is for the lock service to hand out a number that increases with each acquisition, and for the *storage* to reject writes carrying a token older than one it has already seen. Redlock does not produce such tokens.

His framing is the useful takeaway. If the lock is for **efficiency** (avoid computing the same cache entry twice, avoid sending a duplicate email), a single Redis node with `SET NX PX` is enough; an occasional double is harmless. If the lock is for **correctness** (never sell seat A7 twice), do not rely on any lease-based lock alone. Make the database enforce the rule. Antirez published a rebuttal, and the Redis docs link both; read them side by side once.

### The seat-hold design

In the capstone a user picks seats, gets a 10-minute hold, then confirms and pays. The hold is a UX feature: it stops other users from grabbing seats someone is checking out. It is a lock for efficiency and fairness, not for correctness.

Keys: one per seat, `hold:{event:42}:seat:A7`, value = the holder's id (user id or a checkout id), TTL = hold duration. Holding several seats must be all-or-nothing, so a Lua script checks every seat first and writes only if all are free (or already held by the same user, which refreshes the hold):

```lua
-- KEYS = hold keys, one per seat (same {event:N} hash tag)
-- ARGV[1] = holder id, ARGV[2] = ttl in ms
for _, key in ipairs(KEYS) do
  local owner = redis.call('GET', key)
  if owner and owner ~= ARGV[1] then
    return {0, key}                     -- first conflicting seat; nothing was written
  end
end
for _, key in ipairs(KEYS) do
  redis.call('SET', key, ARGV[1], 'PX', ARGV[2])
end
return {1, ''}
```

I ran this locally: user 7 held A1 and A2; user 8 asking for A2 and A3 got `[0, 'hold:{event:42}:seat:A2']`; after the 1 s TTL passed, user 8's request succeeded.

Why is Postgres still the source of truth?

- Holds can vanish: Redis restarts without persistence, failover loses the last writes, eviction removes keys, or the hold expires while the user is still paying.
- So the booking endpoint must not trust "I hold it in Redis" as proof. It inserts the booking in a transaction where the database guarantees uniqueness, for example a `UNIQUE (event_id, seat_id)` constraint on booked seats, or `SELECT ... FOR UPDATE` on the seat rows, or a conditional `UPDATE seats SET status='booked' WHERE id = ANY(:ids) AND status='available'` that must touch every row.
- If Redis says "held by you" but Postgres says "already booked", Postgres wins and the user gets 409.
- The version column or the unique constraint is effectively your fencing token: a stale writer is rejected by the storage, which is exactly Kleppmann's recommendation.

On successful booking, delete the holds (compare-and-delete per seat, or just let them expire). Show remaining hold time from `PTTL`.

### Pitfalls

- Releasing with `DEL` instead of compare-and-delete.
- Choosing a TTL shorter than the work. If you need longer, extend with a compare-and-`PEXPIRE` script while you still own it.
- Holding seats with separate `SET NX` calls from Python. A partial failure leaves some seats held and some not.
- Treating a Redis lock as the thing that prevents overselling. That is the database's job.
- Keys for one multi-key script without a shared hash tag. Fine on one node, `CROSSSLOT` error in Cluster.

## 7. Idempotency keys with Redis

An idempotency key lets a client safely retry a non-idempotent request. The client generates a unique key (a UUID) per logical operation and sends it as `Idempotency-Key`. The server makes sure the operation happens at most once per key and returns the same response to every retry. For `POST /events/{id}/bookings` this is the difference between "network timeout, user taps again, gets two bookings" and "user taps again, sees the same booking".

### What to store

One Redis key per (client, idempotency key), for example `idem:{user:7}:<uuid>`. Scope by user so one client cannot read another's response by guessing keys. The value is a small JSON record that moves through two states:

- `in_progress` with the request fingerprint, written when the first request starts. Short TTL (say 30 s) so a crashed worker does not block retries forever.
- `done` with the fingerprint, status code and response body, written when the handler finishes. Long TTL (24 h is common) so retries over a day get the replay.

The **fingerprint** is a hash of method, path and body. It catches a client bug where the same key is reused for a *different* request: you must not replay booking A's response for a request that asked for seat B.

### The flow

1. `SET idem:... '{"state":"in_progress","fp":...}' NX EX 30`. If it returns OK, you own the key: run the handler.
2. If it returns nil, `GET` the record:
   1. different fingerprint -> 422 (key reused for a different payload);
   2. `in_progress` -> 409 (the first attempt is still running; retry later);
   3. `done` -> replay the stored status and body.
3. When the handler succeeds, overwrite the record with the `done` state and the response.
4. When the handler fails with a 5xx, delete the record so the client can retry. For 4xx you can store the error too, so retries are consistent.

&#91;embedded content: idempotency-key flow · one claim, three outcomes for a retry\]

Only the request that wins `SET NX` runs the handler; every later request with the same key is answered from the stored record.

The status codes match the IETF `Idempotency-Key` header draft (version 07, now expired but widely followed): 400 when a required key is missing, 422 for reuse with a different payload, 409 while the original is still processing.

```python
import hashlib, json
from dataclasses import dataclass
from redis.asyncio import Redis

IN_PROGRESS_TTL_S = 30
RESULT_TTL_S = 24 * 3600

@dataclass
class Replay:
    status: int
    body: dict

class KeyReusedWithDifferentPayload(Exception): ...
class RequestInProgress(Exception): ...

def fingerprint(method: str, path: str, body: bytes) -> str:
    return hashlib.sha256(f"{method} {path}\n".encode() + body).hexdigest()

async def begin(r: Redis, key: str, fp: str) -> Replay | None:
    """None means: you own this key, run the handler."""
    marker = json.dumps({"state": "in_progress", "fp": fp})
    if await r.set(key, marker, nx=True, ex=IN_PROGRESS_TTL_S):
        return None
    raw = await r.get(key)
    if raw is None:                     # expired between SET and GET; try again
        return await begin(r, key, fp)
    record = json.loads(raw)
    if record["fp"] != fp:
        raise KeyReusedWithDifferentPayload
    if record["state"] == "in_progress":
        raise RequestInProgress
    return Replay(record["status"], record["body"])

async def finish(r: Redis, key: str, fp: str, status: int, body: dict) -> None:
    record = {"state": "done", "fp": fp, "status": status, "body": body}
    await r.set(key, json.dumps(record), ex=RESULT_TTL_S)
```

I ran two concurrent calls with the same key against a local server: one created the booking, the other got "in progress"; a third call afterwards got the replay, and the handler body ran once. A different body with the same key raised the conflict.

### Races and the gap Redis cannot close

- `SET NX` makes the claim atomic: two concurrent first requests cannot both own the key.
- The danger zone is a worker that commits the booking in Postgres and then dies before `finish`. The in-progress marker expires after 30 s, the client retries, and the handler would run again. Close this gap in the database: store the idempotency key in the `bookings` table with a `UNIQUE (user_id, idempotency_key)` constraint. The second insert fails, and you can load and return the existing booking. Redis gives you the fast replay path and the concurrency gate; Postgres gives you the guarantee.
- If the handler is slower than the in-progress TTL, a retry can start while the first is still running. Pick a TTL comfortably above your p99 latency, or refresh it.
- Store the response you actually sent (status and body), not a re-computation. The booking may have changed since.

### Pitfalls

- Keying only by the header value, so two users can collide or read each other's replays.
- No fingerprint check, so a reused key returns the wrong booking.
- Leaving the in-progress marker after a 5xx, so the client is stuck with 409 until the TTL runs out.
- Relying on Redis alone for at-most-once: eviction, a restart or a failover can drop the record.
- Storing idempotency records on an instance with an `allkeys-*` eviction policy; under memory pressure they are evicted like cache entries.

## 8. Persistence and availability

Redis lives in RAM, so persistence is about how much you lose when the process or machine dies, and how long a restart takes. Availability is about what happens when a node disappears. In both areas Redis trades a small window of lost writes for speed, which is fine for caches and holds, and is the reason bookings live in Postgres.

### RDB snapshots

RDB writes a compact binary snapshot of the whole dataset. On `BGSAVE` Redis forks; the child writes the file from a copy-on-write view of memory while the parent keeps serving. Snapshots are triggered by `save <seconds> <changes>` rules. On a stock server with no config file, `CONFIG GET save` returned `3600 1 300 100 60 10000`: snapshot after 1 hour if at least 1 key changed, after 5 minutes if 100 changed, after 60 s if 10,000 changed.

On a crash you lose everything written since the last completed snapshot, which can be minutes. Restarts are fast because loading one compact file is quick. The fork can be expensive on a large, write-heavy dataset (copy-on-write pages double memory in the worst case).

### AOF (append-only file)

AOF logs every write command. On restart Redis replays the log. How much you lose depends on when the log is fsynced to disk:

| Setting | When data hits disk | Loss on power failure | Speed |
| --- | --- | --- | --- |
| RDB only (default) | at each snapshot | everything since the last snapshot (minutes) | fastest; fork cost at snapshot |
| AOF `appendfsync no` | when the OS flushes (often \~30 s on Linux) | up to the OS flush interval | fast |
| AOF `appendfsync everysec` (AOF's default) | once per second, in a background thread | about 1 s of writes | near RDB speed |
| AOF `appendfsync always` | before replying to each batch of commands | in principle none that were acknowledged | much slower; disk-latency bound |
| RDB + AOF | both | as the AOF setting; AOF is used on restart | good balance |

Two distinctions that interviewers like:

- A **process crash** (OOM kill, segfault) with `everysec` usually loses nothing, because data already written to the OS page cache survives the process. A **machine crash or power loss** is what loses the last second.
- AOF is off by default (`appendonly no`). The AOF is periodically rewritten to stay compact; since Redis 7 it is a directory of a base file plus incremental files tracked by a manifest.

For the capstone's Compose file, `appendonly yes` with `everysec` and a named volume is a sensible default. With RDB only, a crash can wipe recent seat holds and idempotency records; with `everysec` you lose at most about a second of them; `always` makes every Redis write wait for the disk, which defeats the point of using Redis for hot paths.

### Replication (asynchronous)

A replica connects to a primary, receives a snapshot, then a stream of write commands. The primary does not wait for replicas before replying to the client. So a write can be acknowledged and then lost if the primary dies before the replica receives it. `WAIT numreplicas timeout` lets a client block until N replicas have the write, which narrows the window but does not make Redis strongly consistent.

### Sentinel: automatic failover

Sentinel processes monitor a primary and its replicas. When enough Sentinels (the quorum) agree the primary is unreachable, a majority of Sentinels must authorise a failover; they promote a replica and tell the others to follow it. Clients ask Sentinel for the current primary's address. Run at least three Sentinels on independent machines. Failover keeps the service available, but acknowledged writes that had not replicated are lost. `min-replicas-to-write 1` with `min-replicas-max-lag 10` makes a primary that has lost all its replicas stop accepting writes, which bounds how much an isolated old primary can accept.

### Redis Cluster: sharding

Cluster splits the keyspace into **16,384 hash slots**. A key's slot is `CRC16(key) mod 16384`, and each primary owns a range of slots. Each primary can have replicas, and failover is built in. Clients learn the slot map and get `MOVED` (slot lives elsewhere, update your map) or `ASK` (slot is migrating, ask the other node once) redirections.

The catch is multi-key operations. `MGET`, `MULTI/EXEC` over several keys, and Lua scripts with several `KEYS` only work when all keys are in the same slot; otherwise you get a `CROSSSLOT` error. **Hash tags** fix this: if a key contains `{...}`, only the part inside the first braces is hashed.

```text
hold:{event:42}:seat:A1    -> slot of "event:42"
hold:{event:42}:seat:A2    -> same slot, so one Lua script can hold both
rlc:{ip:1.2.3.4}:28828     -> slot of "ip:1.2.3.4"
```

Do not overdo it: putting everything under one tag puts everything on one node.

### Pub/Sub vs Streams

|  | Pub/Sub | Streams |
| --- | --- | --- |
| Storage | none; delivered to whoever is connected now | persisted entries with IDs, trimmable |
| Delivery | at most once; offline subscribers miss messages | at least once with consumer groups and `XACK` |
| Replay | no | yes, read from any ID |
| Use | cache-invalidation broadcasts, live notifications | work queues, event logs, small Kafka-like pipelines |

For `booking.created` the capstone uses Kafka, which gives you durable, partitioned, replayable logs. Pub/Sub would be fine for "tell every API worker to drop its in-process cache" because missing one message just means a stale entry until its TTL.

### Pitfalls

- Running Redis in Compose without a volume, then being surprised that `docker compose down` erased everything.
- Assuming a replica has every acknowledged write.
- Two Sentinels. A single machine failure can leave no majority.
- Multi-key scripts without hash tags, which work locally and fail in Cluster.
- Using Pub/Sub for anything that must not be lost.

## 9. The Python client: redis-py with asyncio

Use `redis.asyncio` from the `redis` package (redis-py 5 or later; the old `aioredis` project was merged into it). Create one client per process at startup, share it, and close it on shutdown. Everything else (pools, scripts, pipelines) hangs off that client.

### Client, pool and decoding

`Redis(...)` or `Redis.from_url(...)` creates an internal connection pool. Each awaited command borrows a connection, sends, reads the reply and returns it. With asyncio, many coroutines share the pool; the pool size caps concurrent in-flight commands, not total throughput.

```python
from redis.asyncio import Redis, ConnectionPool

pool = ConnectionPool.from_url(
    "redis://redis:6379/0",
    max_connections=50,          # cap per process
    decode_responses=True,       # str instead of bytes
    socket_connect_timeout=2,    # seconds to establish TCP
    socket_timeout=2,            # seconds to wait for a reply
    health_check_interval=30,    # PING idle connections before reuse
)
r = Redis.from_pool(pool)        # the client owns the pool; r.aclose() closes it
```

- `decode_responses=True` turns replies into `str`. Convenient for JSON and ids. Leave it off on a separate client if you store binary data (MessagePack, images).
- The plain `ConnectionPool` raises `MaxConnectionsError` when all connections are busy. `BlockingConnectionPool` waits (up to its `timeout`) instead, which is often kinder under bursts.
- In the installed redis-py 8.1, `socket_timeout` defaults to 5 s; older versions had no timeout, so a dead connection could hang a request forever. Set both timeouts explicitly so the value is visible in your config.
- redis-py 6+ retries `ConnectionError` and `TimeoutError` three times with backoff by default; pass `retry=Retry(ExponentialBackoff(), 3)` to tune it. Retries are not safe for non-idempotent commands like `INCR` if the first attempt actually reached the server.
- redis-py 8 speaks RESP3 on the wire by default but keeps RESP2-style Python return shapes.

### Pipelines

```python
async with r.pipeline(transaction=False) as pipe:
    pipe.get(f"cache:event:{event_id}")
    pipe.zscore("leaderboard:bookings", f"event:{event_id}")
    cached, score = await pipe.execute()
```

Commands on a pipeline are not awaited individually; they queue locally and go out on `execute()`. `transaction=True` (the default) wraps them in MULTI/EXEC.

### Scripts with register\_script

`r.register_script(source)` returns an `AsyncScript`. Calling it sends `EVALSHA`; if Redis answers `NOSCRIPT` (cache flushed by a restart or failover), it loads the script and retries automatically. I tested this by running `SCRIPT FLUSH` and calling the script again: it still worked.

```python
from pathlib import Path
from redis.commands.core import AsyncScript

SCRIPTS = Path(__file__).parent / "lua"

def load_scripts(r: Redis) -> dict[str, AsyncScript]:
    return {
        name: r.register_script((SCRIPTS / f"{name}.lua").read_text())
        for name in ("hold_seats", "release_hold", "sliding_window")
    }

# usage
ok, conflict = await scripts["hold_seats"](keys=hold_keys, args=[user_id, ttl_ms])
```

You can run a script inside a pipeline with `await script(keys=..., args=..., client=pipe)`. Keep `.lua` files in the repo so they are reviewed and diffed like code.

### FastAPI lifespan

Create the client in the lifespan handler, keep it on `app.state`, and close it with `aclose()`. Do not create a client per request; you would open a new pool each time.

```python
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from fastapi import FastAPI, Request
from redis.asyncio import Redis

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    redis = Redis.from_url(settings.redis_url, decode_responses=True,
                           max_connections=50, socket_timeout=2, socket_connect_timeout=2)
    await redis.ping()                       # fail fast if misconfigured
    app.state.redis = redis
    app.state.scripts = load_scripts(redis)
    try:
        yield
    finally:
        await redis.aclose()                 # close() is deprecated on the async client

app = FastAPI(lifespan=lifespan)

def get_redis(request: Request) -> Redis:
    return request.app.state.redis
```

Inject it with `Depends(get_redis)`. In tests you can override `get_redis` to point at a test container.

### Error handling

The exceptions live in `redis.exceptions`. `RedisError` is the base. The ones you will meet:

- `ConnectionError` and `TimeoutError` (note: these are redis-py's own classes, not the builtins) when the server is unreachable or slow.
- `ResponseError` for command errors such as `WRONGTYPE` or an error raised inside a Lua script.
- `WatchError` when an optimistic transaction is aborted.
- `MaxConnectionsError` when the pool is exhausted.

Decide per feature what a Redis failure means. Cache: log and fall back to Postgres. Rate limiter: usually fail open. Seat holds and idempotency: fail the request with 503, because silently skipping them changes behaviour the user relies on.

### Pitfalls

- Creating `Redis()` inside a request handler or dependency without caching it.
- Forgetting `aclose()`; you get "unclosed connection" warnings and leaked sockets in tests.
- Mixing `decode_responses=True` code with code that expects bytes.
- Catching the builtin `TimeoutError` instead of `redis.exceptions.TimeoutError`.
- Sharing one async client across different event loops (common in pytest). Create it inside the loop that uses it.

## Apply it to the capstone

Work through the build tasks in this order; each one reuses the client and script loading from the first. The sketches show shape and key decisions. The SQL, schemas and error mapping are yours to write.

### 0. Compose service

```yaml
  redis:
    image: redis:8
    command: ["redis-server", "--appendonly", "yes", "--appendfsync", "everysec",
              "--maxmemory", "256mb", "--maxmemory-policy", "volatile-lru"]
    volumes: ["redis-data:/data"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
```

Make the API service `depends_on: redis: condition: service_healthy`. `valkey/valkey:8` is a drop-in alternative.

### 1. Async client with a pool in the lifespan

Use the lifespan pattern from section 9. Add `redis_url`, `seat_hold_ttl_s = 600` and the rate-limit numbers to your Pydantic settings so tests can override them. Load all Lua scripts once in the lifespan and store them on `app.state.scripts`.

- [ ] `GET /health` pings Redis and reports it separately from Postgres.

### 2. Cache `GET /events/{id}`, invalidate on `PATCH`

- Key: `cache:v1:event:{id}`. Value: the response model's JSON (`EventOut.model_dump_json()`). TTL: 300 s plus jitter.
- In the PATCH handler, delete the key **after** the DB commit. Put this in the service layer, not the router, so any future write path gets it too.
- Wrap Redis calls in `try/except RedisError` and fall back to Postgres.
- Hint: add a response header such as `X-Cache: HIT|MISS` during development. It makes the tests trivial to write.

### 3. "Most booked events" leaderboard

- On each successful booking, `ZINCRBY leaderboard:bookings <seat_count> event:<id>` after the DB commit.
- `GET /events/popular?limit=10` reads `ZRANGE ... REV WITHSCORES` and then loads titles (from the cache or one `IN (...)` query).
- Think about it: if Redis loses the sorted set, how do you rebuild it? (One `GROUP BY event_id` query over bookings. Write that as a management command.)
- Variation for later: a weekly board with key `leaderboard:bookings:2026-W43` and a TTL of a few weeks.

### 4. Seat hold via an atomic Lua script

- Endpoint: `POST /events/{id}/holds` with a list of seat ids. Use the `hold_seats` script from section 6 with keys `hold:{event:<id>}:seat:<seat>` and `ARGV = [user_id, ttl_ms]`.
- Validate seat ids against Postgres first (they exist, belong to the event, are not already booked). The script only arbitrates between concurrent holders.
- Return `201` with `expires_at`, or `409` naming the conflicting seat.
- Booking creation: check the holds belong to the caller (one `MGET`), then insert in Postgres with the uniqueness guarantee doing the real work. Delete the holds after commit with the compare-and-delete script.

```python
async def hold_seats(scripts: dict[str, AsyncScript], event_id: int, seat_ids: list[str],
                     holder: str, ttl_s: int) -> str | None:
    keys = [f"hold:{{event:{event_id}}}:seat:{s}" for s in sorted(seat_ids)]
    ok, conflict = await scripts["hold_seats"](keys=keys, args=[holder, ttl_s * 1000])
    return None if ok else conflict      # None = held; otherwise the first conflicting key
```

Note the doubled braces in the f-string: `{{event:42}}` renders as `{event:42}`.

### 5. Sliding-window rate limiter middleware

- Use the sliding-window-log script from section 5. Key by authenticated user id when present, else client IP.
- Make limit and window configurable; tests will set something like 5 per 2 s.
- On deny return 429 with `Retry-After` rounded up. Exempt `/health` and `/docs`.
- Decide and document fail-open vs fail-closed.
- Stretch: a stricter limit on `POST /events/{id}/bookings` only, implemented as a dependency rather than global middleware.

### 6. Idempotency-Key on `POST /events/{id}/bookings`

- Require the header (400 if missing). Key: `idem:{user:<id>}:<header value>`. Fingerprint: method, path and raw body.
- Use `begin` / `finish` from section 7. Map the outcomes to 422 (different payload), 409 (in progress) and a replay with the stored status and body.
- Add `idempotency_key` to the `bookings` table with `UNIQUE (user_id, idempotency_key)`. On a unique-violation, load and return the existing booking. That is your safety net when Redis loses the record.
- Only publish `booking.created` to Kafka once, from the path that actually inserted the row (ideally via an outbox table, which is a later week's topic).

### 7. Write the crash-loss paragraph

In your README, answer: if the Redis container is killed (process crash) and if the host loses power (machine crash), what is lost under RDB-only, AOF `everysec` and AOF `always`, for each kind of key you store (cache, holds, rate-limit windows, idempotency records, leaderboard)? Then explain why none of these losses can oversell a seat. Use the table in section 8; a good answer is about 150 words and names the Postgres constraint that saves you.

### Tests

Use a real Redis in a container. `testcontainers` has a Redis module; a session-scoped container plus a function-scoped `FLUSHDB` keeps tests fast and isolated.

```python
import pytest
from testcontainers.redis import RedisContainer
from redis.asyncio import Redis

@pytest.fixture(scope="session")
def redis_url() -> str:
    with RedisContainer("redis:8") as c:
        yield f"redis://{c.get_container_host_ip()}:{c.get_exposed_port(6379)}/0"

@pytest.fixture
async def redis(redis_url: str):
    client = Redis.from_url(redis_url, decode_responses=True)
    await client.flushdb()
    yield client
    await client.aclose()
```

Create the async client inside the test's event loop (function scope, as above) to avoid cross-loop errors with pytest-asyncio. Then:

- [ ] **Cache hit and invalidation:** GET twice, assert the second is a hit (header, or a DB-call counter). PATCH, then GET, assert a miss and the new title.
- [ ] **Hold expiry:** set `seat_hold_ttl_s` to 1, hold seat A1 as user 1, assert user 2 gets 409, `await asyncio.sleep(1.2)`, assert user 2 now succeeds. Avoid exact-boundary sleeps; leave margin.
- [ ] **Rate limit:** with limit N, send N requests and assert 2xx, send one more and assert 429 with a positive integer `Retry-After`.
- [ ] **Idempotency:** POST twice with the same key and body, assert identical status and body and exactly one row in `bookings`. Then fire both concurrently with `asyncio.gather` and assert one booking and one 409 or replay. Same key, different body: 422.
- [ ] **Leaderboard order:** book 3 seats for event A and 1 for event B, assert A ranks first.
- [ ] **Redis down:** stop the client (or point at a closed port) and assert `GET /events/{id}` still returns 200 from Postgres.

## Check yourself

Answer out loud before reading the answers.

1. Redis is single-threaded for command execution. Why is it still fast, and what does that model guarantee you about a single command?
2. What changed with I/O threads in Redis 8, and does it weaken command atomicity?
3. You need to count bookings per event and show a top-10. Which data type and which commands?
4. Explain the difference between a pipeline, MULTI/EXEC and a Lua script. When is each the right tool?
5. A MULTI/EXEC block has three commands and the second fails with WRONGTYPE. What state is the data in afterwards?
6. In cache-aside, why do you delete the key on update instead of writing the new value, and why does the order (commit, then delete) matter?
7. A popular event's cache entry expires and the database spikes. Name three mitigations and their trade-offs.
8. Compare a fixed window and a sliding window log rate limiter. Why must the sliding log be a Lua script?
9. Why must a Redis lock be released with compare-and-delete rather than DEL?
10. Summarise Kleppmann's critique of Redlock. When is a single-node Redis lock acceptable?
11. Walk through the idempotency-key flow for a booking request, including two concurrent requests with the same key. Where can Redis alone fail you?
12. With AOF `appendfsync everysec`, what is lost on a process crash vs a power loss? How does Redis Cluster let one Lua script touch several keys?

## Answers

1. Data is in RAM and most commands are tiny, so the bottleneck is network I/O, not CPU; a single thread avoids lock overhead. Because only one command executes at a time, each command is atomic: no other client sees or changes data mid-command.
2. Redis 8 reworked `io-threads`: extra threads read and parse requests and write replies, while the main thread still executes every command. Atomicity is unchanged. It is off by default (`io-threads 1`).
3. A sorted set: `ZINCRBY leaderboard:bookings <seats> event:<id>` on each booking, `ZRANGE leaderboard:bookings 0 9 REV WITHSCORES` to read. O(log N) updates, ordered reads for free.
4. A pipeline batches commands to save round trips but is not atomic. MULTI/EXEC runs a queued batch without interleaving but cannot branch on values read inside it. A Lua script runs read, decide and write atomically on the server. Use pipelines for throughput, MULTI/EXEC for "apply these writes together", Lua for read-modify-write such as holds and rate limits.
5. Commands one and three ran and kept their effects; command two returned an error. Redis has no rollback. Only queue-time errors (syntax, unknown command) abort the whole EXEC.
6. Deleting is order-independent: two writers racing cannot leave the older value in the cache, and the next reader loads the committed state. Deleting before the commit lets a reader repopulate the cache with the old row before your transaction lands.
7. Jittered TTLs (cheap, only spreads expiries); a rebuild lock with `SET NX PX` so one worker reloads (others wait or serve stale; adds latency); early probabilistic refresh or background refresh (no misses for hot keys; extra work and code). Also stale-while-revalidate and in-process request coalescing.
8. A fixed window is one counter per window but allows up to twice the limit across a boundary. A sliding log keeps one timestamped entry per request and is exact. Its prune, count and add steps must be atomic, otherwise two concurrent requests both see room and both get in.
9. The lock may have expired and been taken by someone else while you were paused. `DEL` would remove their lock. Compare-and-delete removes it only if the stored token is still yours, atomically.
10. Lease-based locks cannot stop a paused client from acting after its lease expired, and Redlock relies on bounded delays and clock behaviour. Correctness needs fencing tokens checked by the storage, or a consensus system. A single Redis lock is fine when it is for efficiency, where an occasional double execution is harmless.
11. `SET idem:{user}:<key> in_progress NX EX 30`: the winner runs the handler and then stores status and body with a 24 h TTL. A concurrent loser sees in\_progress and gets 409; a later retry gets the replay; a different fingerprint gets 422. Redis can lose the record (eviction, restart, failover) or the worker can die between the DB commit and saving the result, so a `UNIQUE (user_id, idempotency_key)` constraint in Postgres is the real guarantee.
12. A process crash usually loses nothing, because written data sits in the OS page cache. A power loss can lose about the last second. In Cluster, put a shared hash tag in the key names (`hold:{event:42}:seat:A1`) so all keys map to the same slot.

## Sources

Pages opened while writing these notes (October 2026). Code examples were run against a local Redis 7.0 server with redis-py 8.1; Redis 8.x-only features are marked in the text.

- [Redis licenses](https://redis.io/legal/licenses/)
- [Redis releases on GitHub](https://github.com/redis/redis/releases)
- [Redis 8.0 release notes](https://redis.io/docs/latest/operate/oss_and_stack/stack-with-enterprise/release-notes/redisce/redisos-8.0-release-notes/)
- [Redis 8.0-M03 blog post (new I/O threading)](https://redis.io/blog/redis-8-0-m03-is-out-even-more-performance-new-features/)
- [Valkey home page](https://valkey.io/) and [Valkey blog](https://valkey.io/blog/)
- [Bloom filter docs](https://redis.io/docs/latest/develop/data-types/probabilistic/bloom-filter/)
- [HEXPIRE command](https://redis.io/docs/latest/commands/hexpire/)
- [SET command](https://redis.io/docs/latest/commands/set/)
- [Transactions](https://redis.io/docs/latest/develop/using-commands/transactions/)
- [Scripting with Lua](https://redis.io/docs/latest/develop/programmability/eval-intro/)
- [Key eviction](https://redis.io/docs/latest/develop/reference/eviction/)
- [Distributed locks with Redis](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)
- [Martin Kleppmann, How to do distributed locking (2016)](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
- [Persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Sentinel](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/)
- [Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- [Pub/Sub](https://redis.io/docs/latest/develop/pubsub/)
- [redis-py asyncio examples](https://redis.readthedocs.io/en/stable/examples/asyncio_examples.html)
- [redis-py production usage](https://redis.io/docs/latest/develop/clients/redis-py/produsage/)
- [Cache stampede (Wikipedia, cites Vattani et al. 2015)](https://en.wikipedia.org/wiki/Cache_stampede)
- [RFC 6585, section 4: 429 Too Many Requests](https://www.rfc-editor.org/rfc/rfc6585#section-4)
- [IETF draft: The Idempotency-Key HTTP header field, version 07](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-07)
