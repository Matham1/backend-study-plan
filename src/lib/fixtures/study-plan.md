# Backend Study Plan (Python)

Oct 23, 2026 · @Mathew Matholomew

## How to use this plan

Work through the weeks in order, top to bottom: about 10 weeks (Week 0 plus Weeks 1–9) at 8–10 hours a week. Nothing in a week depends on a later week.

**Every week has the same shape:**

1. **Goal:** one line on what you'll have by Friday.
2. **Study, in order:** numbered readings with a rough day, and specific chapters or sections rather than whole books.
3. **Build:** tasks in the capstone project that use exactly what you just studied.
4. **Test:** tests for what you built that week, so testing grows with the project instead of waiting until the end.
5. **Self-check (some weeks):** questions from the roadmap repo's notes to answer out loud before peeking.

A week is done when every Build and Test box is ticked.

**Study notes:** each week links its own notes doc, with explanations, Python examples for the capstone, pitfalls, and self-test questions with answers. Read the notes first, then use the official resources in the Study list to go deeper.

**The capstone: an event-booking API.** Users browse events, book seats and get notified. It grows one layer per week: setup, async, REST, Postgres, Redis, Kafka, NoSQL design, auth, full integration tests, and security.

**Background book:** [Designing Data-Intensive Applications, 2nd ed.](https://martin.kleppmann.com/2026/03/24/designing-data-intensive-applications-2e.html) (Kleppmann & Riccomini, March 2026). Specific chapters are assigned in Weeks 3 and 6; the rest is optional.

## Week 0 — Setup (2–3 days)

**Goal:** a running FastAPI + Postgres skeleton in Docker Compose, with migrations and one passing test.

**Study notes:** [Week 0: Project Setup](https://claude.ai/artifact/MJ3xqxk7eGcDGqPfAsfjVp)

**Study, in order**

1. **Day 1:** Docker docs, [Docker Compose quickstart](https://docs.docker.com/compose/gettingstarted/): services, volumes, healthchecks, `depends_on`.
2. **Day 1:** [FastAPI tutorial](https://fastapi.tiangolo.com/tutorial/), from "First Steps" through "Request Body" and "Response Model".
3. **Day 2:** [SQLAlchemy 2.0 Unified Tutorial](https://docs.sqlalchemy.org/en/20/tutorial/), sections "Working with Database Metadata" and "Data Manipulation with the ORM".
4. **Day 2:** [Alembic tutorial](https://alembic.sqlalchemy.org/en/latest/tutorial.html) and the "Auto Generating Migrations" page.
5. **Day 3:** [Architecture Patterns with Python](https://www.cosmicpython.com/book/chapter_02_repository.html) (free online), chapter 2 "Repository Pattern".
6. **Day 3:** pytest docs, [Get Started](https://docs.pytest.org/en/stable/getting-started.html).

**Build**

- [ ] Compose file with Postgres (with a healthcheck) and the API service
- [ ] Project layout: `api/`, `schemas/`, `services/`, `repositories/`, `models/`
- [ ] `Event` model and the first Alembic migration
- [ ] `POST /events` and `GET /events/{id}` working (plain sync code is fine this week)

**Test**

- [ ] One pytest test that creates an event and reads it back through `TestClient`

## Week 1 — Async Python (5 days)

**Goal:** understand how the event loop schedules work, and make the app async end to end. The rule that matters most in production: never block the loop.

**Study notes:** [Week 1: Async Python](https://claude.ai/artifact/BjSKD1axtJykcFxjLc27dB)

**Study, in order**

1. **Day 1:** [FastAPI docs: Concurrency and async/await](https://fastapi.tiangolo.com/async/), then David Beazley's PyCon 2015 talk "Python Concurrency From the Ground Up" (YouTube). Concurrency vs parallelism, threads vs processes, the GIL.
2. **Days 1–2:** [Python docs: Coroutines and Tasks](https://docs.python.org/3/library/asyncio-task.html): `create_task`, `gather`, `TaskGroup`, `asyncio.timeout`, cancellation. Read alongside Real Python's [Async IO in Python: A Complete Walkthrough](https://realpython.com/async-io-python/).
3. **Day 3:** Python docs, [Synchronization Primitives](https://docs.python.org/3/library/asyncio-sync.html) (`Semaphore`) and [Queues](https://docs.python.org/3/library/asyncio-queue.html).
4. **Day 3:** Python docs, [Developing with asyncio](https://docs.python.org/3/library/asyncio-dev.html): debug mode, detecting blocking calls, `asyncio.to_thread`.
5. **Day 4:** [SQLAlchemy asyncio extension](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html) and FastAPI's "Dependencies with yield" page.
6. **Day 5:** [pytest-asyncio docs](https://pytest-asyncio.readthedocs.io/), Getting Started.
7. **Optional, to go deeper:** *Python Concurrency with asyncio* (Matthew Fowler, Manning), chapters 1–5, up to and including non-blocking database drivers.

**Build**

- [ ] Throwaway script: time 100 HTTP calls sequentially, with `ThreadPoolExecutor`, and with `asyncio`
- [ ] Fetch 500 URLs with at most 20 in flight (`Semaphore`) and a 2-second timeout per call
- [ ] Make the app async: `AsyncSession` + `asyncpg`, async repository, `async def` endpoints
- [ ] Put `time.sleep(1)` in a handler, hit it with 50 concurrent requests, watch latency explode, then fix it
- [ ] A small in-process `asyncio.Queue` producer/consumer (you'll reuse the pattern for the Kafka worker in Week 5)

**Test**

- [ ] Convert the Week 0 test to async with `pytest-asyncio` and `httpx.AsyncClient`

## Week 2 — REST design + testing foundations (5 days)

**Goal:** well-designed, documented endpoints for events and bookings, with fast unit tests and API tests. Making queries fast is Week 3; auth is Week 7, so for now pass the user ID in the path.

**Study notes:** [Week 2: REST API Design](https://claude.ai/artifact/8C2QfapyUy7HTqfNLGW2Tu); [Testing: Unit, Integration and CI](https://claude.ai/artifact/Y1oQq1ccQSk5fEz3ipcAAi), sections 1–5

**Study, in order**

1. **Day 1:** [Zalando RESTful API Guidelines](https://opensource.zalando.com/restful-api-guidelines/), sections "REST Basics – URLs", "HTTP requests" and "HTTP status codes"; then Google [AIP-121 Resource-oriented design](https://google.aip.dev/121).
2. **Day 1:** [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110), skim sections 9.2–9.3 (safe and idempotent methods) and 15 (status codes).
3. **Day 2:** [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457) for error bodies.
4. **Day 2:** Pagination: [AIP-158](https://google.aip.dev/158), then [Use The Index, Luke](https://use-the-index-luke.com/) chapter 7 "Partial Results" (why keyset/cursor pagination beats offset).
5. **Day 3:** Zalando "Compatibility" section (versioning and evolving an API), and RFC 9110 section 13 (conditional requests, ETags).
6. **Day 3:** FastAPI docs: [Bigger Applications](https://fastapi.tiangolo.com/tutorial/bigger-applications/) and "Handling Errors"; Architecture Patterns with Python, chapter 4 (service layer).
7. **Day 4:** Martin Fowler's site: [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html); *Python Testing with pytest*, 2nd ed. (Brian Okken), chapters 2–5: test functions, fixtures, built-in fixtures, parametrization.
8. **Day 5:** [FastAPI docs: Testing](https://fastapi.tiangolo.com/tutorial/testing/) and "Testing Dependencies with Overrides"; Architecture Patterns with Python, chapters 3 and 5 (fakes, and testing at the service layer).

**Build**

- [ ] Endpoints: `GET/POST /events`, `GET/PATCH /events/{id}`, `POST /events/{id}/bookings`, `DELETE /bookings/{id}` (or `POST /bookings/{id}/cancel`, with a note on why), `GET /users/{user_id}/bookings`
- [ ] Meaningful status codes: 201 + `Location`, 204, 404, 409 for sold-out or duplicate bookings, 422
- [ ] One exception handler that returns `application/problem+json`
- [ ] Cursor pagination and filters (`city`, `from`) on `GET /events`; just make it correct for now
- [ ] `ETag` / `If-Match` optimistic locking on `PATCH /events/{id}`
- [ ] Version prefix chosen (`/v1`); every endpoint has a response model and documented errors in OpenAPI

**Test**

- [ ] Unit tests for the booking rules (sold out, duplicate, past event) with `parametrize` and a fake repository
- [ ] API tests for status codes, Problem Details bodies, and pagination edge cases (empty page, last page, bad cursor)
- [ ] Shared fixtures moved into `conftest.py`

**Self-check:** the roadmap repo's [RESTful Architecture notes](https://github.com/aasthas2022/SDE-Interview-and-Prep-Roadmap/blob/main/System%20Design/RESTfulArchitecture.md) ("Top 75 questions"). Some answers are simplified; for example, a repeated `DELETE` can still return 404, because idempotency is about server state, not identical responses. Spot gaps like that.

## Week 3 — PostgreSQL: indexes and transactions (5 days)

**Goal:** every list query is index-backed, and concurrent bookings can never oversell an event.

**Study notes:** [Week 3: PostgreSQL Indexes](https://claude.ai/artifact/2aTF5w2DSgiEQhksTpSwwA) (days 1–3), then [Week 3: Transactions and Concurrency in PostgreSQL](https://claude.ai/artifact/TiWWdVJRuaJboDkrHMvN1H) (days 4–5); [Testing](https://claude.ai/artifact/Y1oQq1ccQSk5fEz3ipcAAi), sections 6–7

**Study, in order**

1. **Day 1:** [Use The Index, Luke](https://use-the-index-luke.com/) (free), chapters 1–3: Anatomy of an Index, The Where Clause, Performance and Scalability.
2. **Day 2:** Postgres docs, [Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html); paste plans into [explain.dalibo.com](https://explain.dalibo.com/) to read them visually.
3. **Days 2–3:** Postgres docs, [Chapter 11: Indexes](https://www.postgresql.org/docs/current/indexes.html): 11.2 index types (B-tree, Hash, GIN, GiST, BRIN), 11.3 multicolumn, 11.7 expression, 11.8 partial, 11.9 index-only scans and covering indexes.
4. **Day 4:** DDIA 2nd ed., chapter 8 "Transactions"; then Postgres docs, [Chapter 13: Concurrency Control](https://www.postgresql.org/docs/current/mvcc.html), sections 13.2 (isolation levels) and 13.3 (explicit locking, `SELECT … FOR UPDATE`).
5. **Day 5:** [The Internals of PostgreSQL](https://www.interdb.jp/pg/) (free), the "Concurrency Control" and "VACUUM Processing" chapters: why every index has a write cost.
6. **Day 5:** Postgres docs on `CREATE INDEX CONCURRENTLY` (in the CREATE INDEX reference page).

**Build**

- [ ] Seed script: about 50k events and 1M bookings
- [ ] Run `EXPLAIN (ANALYZE, BUFFERS)` on every list query; add a composite index for the cursor pagination from Week 2; record before/after timings
- [ ] A partial index (`WHERE status = 'active'`), an expression index (`lower(email)`), and a GIN index on a `jsonb` tags column
- [ ] Measure insert throughput with 0 vs 5 indexes
- [ ] Prevent overselling: a conditional `UPDATE … SET seats_left = seats_left - 1 WHERE seats_left > 0` or `SELECT … FOR UPDATE`, plus a unique constraint on `(user_id, event_id)`
- [ ] Add one index through an Alembic migration using `CREATE INDEX CONCURRENTLY`

**Test**

- [ ] Session-scoped Postgres container with [testcontainers-python](https://testcontainers-python.readthedocs.io/); each test runs inside a transaction that is rolled back
- [ ] Repository tests against the real database
- [ ] Concurrency test: 50 simultaneous bookings for 10 seats, and exactly 10 succeed

**Self-check:** answer sections 9–13 (transactions, ACID, isolation levels, indexing, query tuning) of the roadmap repo's [Database Interview Prep Guide](https://github.com/aasthas2022/SDE-Interview-and-Prep-Roadmap/blob/main/Databases/database-interview-prep-guide.md) out loud before reading its answers.

## Week 4 — Redis (5 days)

**Goal:** use Redis for what it's good at: caching, rate limiting, short-lived holds and idempotency keys, and know what you lose when it crashes.

**Study notes:** [Week 4: Redis in Depth](https://claude.ai/artifact/37pjM9VsoFNCQkebFqrEPV); [Testing](https://claude.ai/artifact/Y1oQq1ccQSk5fEz3ipcAAi), the Week 4 part of "Apply it to the capstone"

**Study, in order**

1. **Days 1–2:** [Redis University](https://redis.io/tutorials/university/), "Get Started with Redis" (free), plus the [redis.io data types docs](https://redis.io/docs/latest/develop/data-types/): strings, hashes, lists, sets, sorted sets, streams.
2. **Day 2:** redis.io docs on pipelining, transactions (`MULTI`/`EXEC`) and Lua scripting; why single-threaded execution makes scripts atomic.
3. **Day 3:** caching patterns: cache-aside, TTLs, invalidation, cache stampedes; redis.io docs on eviction policies.
4. **Day 3:** rate limiting and locks: redis.io docs on distributed locks, then Kleppmann's [How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) for their limits.
5. **Day 4:** Stripe engineering blog, [Designing robust and predictable APIs with idempotency](https://stripe.com/blog/idempotency).
6. **Day 5:** redis.io docs on persistence (RDB vs AOF), replication, Sentinel, and Cluster hash slots.
7. **Throughout:** [redis-py docs](https://redis.readthedocs.io/), using the `redis.asyncio` client.

**Build**

- [ ] Async Redis client with a connection pool, created in FastAPI's lifespan
- [ ] Cache `GET /events/{id}` with a TTL; invalidate it on `PATCH`
- [ ] Sorted-set leaderboard for "most booked events"
- [ ] Seat hold: an atomic Lua script with a configurable TTL (10 minutes by default)
- [ ] Sliding-window rate limiter middleware that returns 429 with `Retry-After`
- [ ] `Idempotency-Key` header on `POST /events/{id}/bookings`, with the stored response replayed on retries
- [ ] One paragraph: what you lose on a crash with RDB, AOF `everysec`, and AOF `always`

**Test**

- [ ] Session-scoped Redis container fixture (testcontainers)
- [ ] Cache test: the second read doesn't hit Postgres; an update invalidates the cache
- [ ] Seat hold with a 1-second TTL expires on time
- [ ] Request N+1 within the window gets 429
- [ ] Same `Idempotency-Key` sent twice gives one booking and identical responses

## Week 5 — Kafka core (5 days)

**Goal:** understand partitions, consumer groups, offsets and delivery guarantees well enough to predict what happens when a broker or consumer dies.

**Study notes:** [Week 5: Kafka Core](https://claude.ai/artifact/M5YCbwndbXgzFSDHSBopN9)

**Study, in order**

1. **Days 1–2:** [Confluent Developer](https://developer.confluent.io/courses/), Kafka 101 (free): topics, partitions, offsets, consumer groups.
2. **Days 2–3:** [Kafka: The Definitive Guide, 2nd ed.](https://www.oreilly.com/library/view/kafka-the-definitive/9781492043072/) (Shapira et al., O'Reilly), chapters 3 "Kafka Producers" and 4 "Kafka Consumers": keys and partitioning, `acks`, idempotent producer, commits, rebalances.
3. **Days 3–4:** Confluent Developer's Kafka Internals course plus the book's chapter 6 "Kafka Internals": replication, in-sync replicas, leader election, KRaft. Use the [Kafka docs Design section](https://kafka.apache.org/documentation/#design) as reference.
4. **Days 4–5:** the book's chapters 7 "Reliable Data Delivery" and 8 "Exactly-Once Semantics".
5. **Throughout:** [confluent-kafka-python docs](https://docs.confluent.io/kafka-clients/python/current/overview.html). Run the consumer as its own process. The library also ships asyncio clients (AIOProducer and AIOConsumer) if you need to produce from async code. Next week you'll publish through an outbox, so request handlers never call Kafka directly.

**Build**

- [ ] Add Kafka (3 brokers, KRaft mode) to Docker Compose
- [ ] Publish `booking.created` keyed by `event_id`, with `acks=all` and idempotence enabled explicitly (unlike Java, it is off by default in the Python client)
- [ ] Notification worker process (reuse the Week 1 queue pattern) that commits offsets only after processing
- [ ] Kill one broker and watch partition leadership move
- [ ] Crash the worker mid-batch and observe redelivery
- [ ] Make the consumer idempotent by deduplicating on booking ID

**Test**

- [ ] Unit tests for the message handler with fake messages, including duplicates and malformed payloads

## Week 6 — Kafka in production + NoSQL intro (5 days)

**Goal:** events leave the system reliably (no lost or phantom `booking.created`), and you can explain where a NoSQL store would or wouldn't fit this app.

**Study notes:** [Week 6: Reliable Event-Driven Patterns](https://claude.ai/artifact/2ck8o9gtyD6hxbtJLDK3pe) (days 1–2), then [Week 6: NoSQL Introduction](https://claude.ai/artifact/1Md5SqUmsBKPibAvzEC1bN) (days 3–5)

**Study, in order**

1. **Day 1:** microservices.io, [Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html); retry topics and dead-letter topics.
2. **Day 2:** Kafka docs Design section on log compaction and retention; microservices.io, [Saga pattern](https://microservices.io/patterns/data/saga.html) (choreography vs orchestration).
3. **Day 3:** DDIA 2nd ed., chapter 3 "Data Models and Query Languages" (document, key-value, wide-column, graph) and chapter 4 "Storage and Retrieval" (LSM-trees vs B-trees).
4. **Day 4:** [MongoDB University](https://learn.mongodb.com/) intro course (free) with `pymongo`; [AWS DynamoDB best practices](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html) on access-pattern-first key design.
5. **Day 5:** DDIA 2nd ed., chapters 6 "Replication" and 7 "Sharding": leaders and followers, eventual consistency, partitioning by key.

**Build**

- [ ] Outbox table written in the same Postgres transaction as the booking, plus a relay process that publishes to Kafka
- [ ] Retry topic and dead-letter topic for messages that keep failing
- [ ] Graceful worker shutdown that commits offsets
- [ ] Write-ups (half a page each): where each NoSQL family would fit in this app; event + bookings modelled as MongoDB documents vs your SQL schema; DynamoDB keys for "bookings by user" and "bookings by event"; which data truly needs strong consistency

**Test**

- [ ] Kafka container (testcontainers): book a seat, and the worker consumes `booking.created` exactly once
- [ ] Booking transaction rolls back, and no outbox row or event is produced

**Self-check:** the repo's [Microservices notes](https://github.com/aasthas2022/SDE-Interview-and-Prep-Roadmap/blob/main/System%20Design/Microservices.md), questions 25, 42, 44–45 and 57–58 (skip 43, which is about service registries) (sagas, orchestration vs choreography, retries, dead-letter queues), comparing its orchestration answer with how Camunda works at your job; and the [Database Interview Prep Guide](https://github.com/aasthas2022/SDE-Interview-and-Prep-Roadmap/blob/main/Databases/database-interview-prep-guide.md), sections 17–23 (NoSQL types, CAP and BASE, replication, sharding, PostgreSQL vs DynamoDB, idempotency).

## Week 7 — Authentication and authorization (5 days)

**Goal:** real users with secure passwords, short-lived tokens and one social login. Every endpoint checks not just who you are but whether this specific booking is yours; most real API breaches are authorization bugs.

**Study notes:** [Week 7: Authentication and Authorization](https://claude.ai/artifact/5Hh5f8bVSGS7wjVqES52HH)

**Study, in order**

1. **Day 1:** [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html): Argon2id, salts, why fast hashes are wrong.
2. **Day 1:** [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html): server-side sessions vs tokens.
3. **Day 2:** [jwt.io introduction](https://jwt.io/introduction) and [PyJWT docs](https://pyjwt.readthedocs.io/): structure, HS256 vs RS256, claims, expiry.
4. **Day 2:** FastAPI security tutorial, from "Security – First Steps" through [OAuth2 with Password (and hashing), Bearer with JWT tokens](https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/); OWASP's JSON Web Token cheat sheet on revocation.
5. **Days 3–4:** [OAuth 2.0 Simplified](https://www.oauth.com/) (Aaron Parecki, free online): authorization code flow, PKCE, scopes, OpenID Connect.
6. **Day 4:** [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): RBAC and object-level checks.
7. **Day 5:** [PortSwigger Web Security Academy](https://portswigger.net/web-security) (free): 2–3 labs each from Authentication, JWT attacks and OAuth.

**Build**

- [ ] Register and login with `argon2-cffi`
- [ ] 15-minute access tokens and rotating refresh tokens; revoked token IDs stored in Redis with a TTL
- [ ] `current_user` dependency; replace `/users/{user_id}/bookings` with `/users/me/bookings`
- [ ] Ownership check: users can only read or cancel their own bookings; an admin role is required to create events
- [ ] "Sign in with GitHub" (or Google) using `authlib`
- [ ] Reuse the Week 4 rate limiter on `/auth/login`

**Test**

- [ ] 401 with no token and with an expired token
- [ ] 403 when reading or cancelling another user's booking, and when a non-admin creates an event
- [ ] A refresh token can't be reused after rotation
- [ ] Login is rate-limited after repeated failures

## Week 8 — Integration tests and CI (5 days)

**Goal:** one command runs fast unit tests and a full-stack integration suite (Postgres, Redis, Kafka), and both run on every push.

**Study notes:** [Testing: Unit, Integration and CI](https://claude.ai/artifact/Y1oQq1ccQSk5fEz3ipcAAi), sections 8–10 and the Week 8 part of "Apply it to the capstone"

**Study, in order**

1. **Days 1–2:** *Python Testing with pytest*, 2nd ed., chapters 9 "Coverage", 10 "Mocking" and 11 "tox and Continuous Integration"; [unittest.mock docs](https://docs.python.org/3/library/unittest.mock.html) for when mocking is (and isn't) the right tool.
2. **Day 2:** [Hypothesis docs](https://hypothesis.readthedocs.io/), quickstart: property-based testing.
3. **Day 3:** `factory_boy` docs for test data; `pytest-cov` docs.
4. **Day 3:** [testcontainers-python docs](https://testcontainers-python.readthedocs.io/) again, now for sharing containers across the whole session.
5. **Day 4:** GitHub Actions docs, "Building and testing Python".

**Build + Test**

- [ ] One session-scoped fixture set that starts Postgres, Redis and Kafka containers
- [ ] End-to-end test: register, log in, book a seat, and the notification worker consumes the event
- [ ] Property test: total booked never exceeds capacity for any sequence of book and cancel operations
- [ ] `factory_boy` factories replace hand-written test data
- [ ] Coverage report; check coverage of `services/`, not just the total
- [ ] Markers to run `unit` and `integration` separately; a GitHub Actions workflow runs both on every push

## Week 9 — Security (optional) + polish (5 days)

**Goal:** audit the finished API against the most common API attacks, and document the design decisions you made along the way.

**Study notes:** [Week 9: API Security](https://claude.ai/artifact/2ngRE5zwmrq7X928MppShE)

**Study, in order**

1. **Days 1–2:** [OWASP API Security Top 10, 2023 edition](https://owasp.org/API-Security/editions/2023/en/0x11-t10/): read all ten risks and their prevention notes.
2. **Day 3:** OWASP cheat sheets on SQL Injection Prevention, Input Validation, REST Security and CSRF Prevention.
3. **Day 4:** OWASP Secrets Management cheat sheet; `pip-audit` and `bandit` docs.

**Build**

- [ ] Audit the API against each of the ten risks and fix what you find
- [ ] Confirm every query is parameterized; set `extra="forbid"` on Pydantic input models to block mass assignment
- [ ] CORS locked to known origins; security headers added
- [ ] Secrets only from environment variables; `pip-audit` and `bandit` added to CI
- [ ] README with an architecture diagram and your decisions: index choices, isolation and locking strategy, delivery semantics, token strategy

## Final capstone checklist

When every box below is ticked, the plan is complete and you have a portfolio project that covers all four of your topics.

- [ ] List events with cursor pagination, filters, and an index-backed query plan
- [ ] Return consistent Problem Details errors and correct status codes
- [ ] Cache event reads in Redis and rate-limit login and booking
- [ ] Book a seat idempotently, with no double-booking under concurrent requests
- [ ] Publish `booking.created` via an outbox and process it exactly once in a worker
- [ ] Authenticate with JWT (access + rotating refresh) and one OAuth provider
- [ ] Block users from reading or cancelling other users' bookings
- [ ] Pass unit and container-based integration tests in CI
