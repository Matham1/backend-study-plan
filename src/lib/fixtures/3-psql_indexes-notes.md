# Study Notes — Week 3: PostgreSQL Indexes

Oct 23, 2026 · @Mathew Matholomew

After this week you will know what PostgreSQL physically does when it uses an index, why the planner sometimes refuses to, and how to read a query plan well enough to prove it. You will design the composite, partial, expression and GIN indexes the event-booking API needs, measure what each one costs on writes, and ship one to production with `CREATE INDEX CONCURRENTLY` from an Alembic migration. Facts are checked against the PostgreSQL 18 manual; the sibling doc covers transactions and locking.

## 1. How PostgreSQL stores rows: heap, pages, TIDs

A PostgreSQL table is an unordered pile of rows called the heap, and every index is a separate structure that points into it. Everything later in this doc follows from that split.

**Pages.** Each table and each index is a file cut into fixed-size pages, normally 8 kB. PostgreSQL never reads a single row from disk; it reads whole pages into its shared buffer cache. So the real unit of cost is "how many pages did we touch", not "how many rows".

**Inside a heap page.** A page starts with a 24-byte header. After it comes an array of 4-byte line pointers (item identifiers) that grows forward. The row data (tuples) is written from the end of the page backward. Free space sits in the middle. A line pointer stores the offset and length of its tuple, so the tuple can be moved inside the page during compaction while the pointer's slot number stays the same.

**Tuples are row versions.** Because of MVCC, an `UPDATE` does not overwrite a row. It writes a new tuple and marks the old one as dead for future transactions. One logical row can therefore have several physical tuples at once. Each tuple header carries `xmin`/`xmax` (which transactions created and deleted it) so readers can decide what they are allowed to see.

**TID / ctid.** The physical address of a tuple is a TID: `(page number, line pointer number)`. You can see it with the hidden `ctid` column. On my seeded capstone table:

```sql
SELECT ctid, id FROM events WHERE id = 200;
--  ctid   | id
-- (2,57)  | 200    -- page 2, slot 57
```

The ctid changes after an `UPDATE` (new tuple) or `VACUUM FULL` (table rewrite). Never store it in your application.

**What an index is.** An index is a second file, sorted by some key, whose entries are `(key, TID)`. Finding a row through an index is always two steps: walk the index to get TIDs, then fetch those heap pages to get the row and check it is visible to your transaction. The index does not store visibility information. That is why a plain index scan usually has to touch the heap even when the index already holds every column you asked for (section 6 explains the exception).

**Heap order is accidental.** Rows land wherever there is free space, roughly in insert order. If you insert bookings in `created_at` order, the heap happens to be sorted by `created_at`, and the statistic `pg_stats.correlation` for that column is close to 1. For `event_id` in random order it is close to 0. This matters: following an index over a well-correlated column touches a few neighbouring pages; over an uncorrelated column, each row can be on a different page.

```sql
SELECT attname, correlation
FROM pg_stats
WHERE tablename = 'bookings' AND attname IN ('created_at', 'event_id');
-- created_at | 1
-- event_id   | 0.0064
```

**Pitfalls**

- Thinking in rows instead of pages. A query that returns 8,000 rows scattered over 5,000 pages is expensive even though 8,000 sounds small.
- Assuming an index makes the heap sorted. It does not; only `CLUSTER` reorders the heap, once, and new rows do not keep that order.
- Forgetting that dead tuples take space until `VACUUM` reclaims it. Update-heavy tables (like `events.seats_left`) grow even when the row count is flat.

## 2. B-tree indexes in depth

A B-tree is a sorted, balanced tree of pages, and it is the default because sorted order answers equality, ranges, `ORDER BY` and `LIMIT` with the same structure. `CREATE INDEX` without `USING` builds one.

**Structure.** The index file holds a metapage, then internal pages and leaf pages, all 8 kB. Leaf pages hold the actual entries `(key, TID)` in key order. Internal pages hold separator keys and downlinks to the level below. The root is the single top internal page. Every leaf is the same distance from the root, so the tree stays balanced. Each level is also a doubly linked list: a leaf knows its left and right sibling. The manual notes that leaf pages are typically over 99% of the index.

**Fan-out is huge.** One 8 kB internal page holds hundreds of separator keys. That is why depth stays tiny. On my seeded data, `bookings_event_id_idx` (1M entries, 975 pages) is only three levels deep: root, one internal level, leaves. A table 100 times larger would add about one level.

&#91;embedded content: B-tree lookup and range scan · 3 steps\]

The picture shows the three parts of every B-tree lookup:

1. **Descend.** Start at the root, binary-search the separator keys, follow the downlink. Repeat until a leaf. Cost: one page per level, so 3 to 4 pages even for very large tables. This part is always cheap.
2. **Walk the leaf chain.** For a range (or for a non-unique key), read entries in order and step to the right sibling when the page ends. Cost grows with the number of matching entries, but entries are packed densely, so it is usually cheap.
3. **Fetch from the heap.** For every TID, read the heap page and check visibility. This is the expensive part. If matching rows are scattered, each TID can mean a different page. Use The Index, Luke makes the same point: only the tree walk has a fixed upper bound; the other two steps can explode.

**Why one structure serves four query shapes.**

| Query shape | What the B-tree does |
| --- | --- |
| `WHERE id = 42` | Descend to the one leaf entry. |
| `WHERE starts_at BETWEEN a AND b` | Descend to `a`, walk right until `> b`. |
| `ORDER BY starts_at` | Walk the leaves in order: rows come out sorted, no Sort node. It can also walk backwards for `DESC`. |
| `ORDER BY starts_at LIMIT 20` | Walk in order and stop after 20 rows. The work is 20 rows, not the whole table. |

The last row is the big one for APIs. Without a matching index, PostgreSQL must read every candidate row and sort it before it can return the first 20. With one, it reads 20 entries and stops. You will see this in section 4.

B-trees support the operators `<`, `<=`, `=`, `>=`, `>`, plus `BETWEEN`, `IN`, `IS NULL`, and `LIKE 'abc%'` (a fixed prefix, under the C collation or with a `text_pattern_ops` index). They cannot help with `LIKE '%abc'` or with a function wrapped around the column.

**Duplicates and deduplication.** Since PostgreSQL 13, a B-tree stores repeated keys once with a list of TIDs (a "posting list"). An index on `bookings(event_id)`, with about 20 bookings per event, is much smaller because of this. It is on by default.

**Pitfalls**

- Indexing a column but filtering on an expression of it: `WHERE date(starts_at) = '2026-06-01'` cannot use an index on `starts_at`. Rewrite as a half-open range: `starts_at >= '2026-06-01' AND starts_at < '2026-06-02'`.
- Mixing sort directions. An index on `(a, b)` serves `ORDER BY a, b` and `ORDER BY a DESC, b DESC`, but not `ORDER BY a ASC, b DESC`. For that you need `(a, b DESC)`.
- Believing depth is the problem. It almost never is. Heap fetches are.

## 3. Access paths: how the planner reads a table

The planner picks the scan with the lowest estimated cost, and that estimate is driven by one number: how many rows it thinks will match (selectivity). An index is a tool the planner may use, never an instruction it must follow.

**The four scans.**

| Scan | What it does | Wins when | Watch out |
| --- | --- | --- | --- |
| Seq Scan | Reads every heap page in order, filters each row | A large share of rows match, or the table is small | Fine on small tables; a red flag on a 1M-row table for a query that returns 10 rows |
| Index Scan | Walks the index, fetches each matching heap tuple in index order | Few rows match, or you need index order (`ORDER BY ... LIMIT`) | Random heap I/O per row when rows are scattered |
| Bitmap Index Scan + Bitmap Heap Scan | Collects all matching TIDs into a bitmap sorted by page, then reads each heap page once | A medium share of rows match, or several indexes are combined with AND/OR | Loses index order, so a Sort is needed; `Recheck Cond` when the bitmap goes lossy |
| Index Only Scan | Answers from the index alone, skips the heap for pages marked all-visible | All needed columns are in the index and the table is well vacuumed | `Heap Fetches` > 0 means the visibility map is stale |

**Why the bitmap scan exists.** A plain index scan visits heap pages in index order, so the same page can be read many times and the reads jump around. A bitmap scan first gathers every TID, sorts them by page, and then reads each page once in physical order. It is the middle ground between "a few rows" (index scan) and "most rows" (seq scan). It can also AND or OR bitmaps from different indexes, for example one on `city` and one on `status`. The price: the output is in physical order, not index order.

**How cost is estimated.** Each plan node gets an abstract cost in units where reading one page sequentially costs 1 (`seq_page_cost`). A random page read costs 4 (`random_page_cost`), and processing a row costs 0.01 (`cpu_tuple_cost`). You can check the arithmetic on a real plan. My `events` table has 725 pages and 50,000 rows, and the query had two filter conditions at 0.0025 each:

```
725 x 1.0 + 50,000 x 0.01 + 50,000 x 2 x 0.0025 = 1475
```

and the plan printed `Seq Scan on events (cost=0.00..1475.00 ...)`. The point is not the formula, it is that random reads are priced at 4x sequential ones. That is why the planner abandons the index once too many rows match.

**Selectivity and statistics.** To estimate how many rows match `city = 'Almaty'`, the planner reads per-column statistics gathered by `ANALYZE`, visible in `pg_stats`:

- `most_common_vals` / `most_common_freqs`: the top values and their share. On my data, `events.status` shows active 0.82, draft 0.14, cancelled 0.05.
- `histogram_bounds`: equal-population buckets for the remaining values, used for range estimates.
- `n_distinct`: the number of distinct values (negative means a fraction of rows).
- `correlation`: how closely heap order follows this column (section 1). High correlation makes index scans cheaper.

The sample size is set by `default_statistics_target` (100 by default). Raise it per column for skewed data: `ALTER TABLE bookings ALTER COLUMN event_id SET STATISTICS 500;` then `ANALYZE bookings;`.

Autovacuum runs `ANALYZE` automatically once roughly 10% of a table has changed. After a bulk load, such as your seed script, run `ANALYZE` yourself. Until then the planner works from stale or default guesses.

**Selectivity in action.** Same index on `bookings(event_id)`, three ranges, three different plans on my seeded data:

| Predicate | Rows matched | Plan chosen |
| --- | --- | --- |
| `event_id = 1234` (one event) | 23 | Bitmap Heap Scan, 23 heap pages |
| `event_id BETWEEN 1000 AND 1400` | 8,154 (0.8%) | Bitmap Heap Scan, 5,407 heap pages |
| `event_id > 100` | 998,000 (99.8%) | Parallel Seq Scan, index ignored |

Note the middle row: 8,154 rows lived on 5,407 different pages out of 9,346. Because `event_id` is uncorrelated with heap order, even 0.8% of rows touched more than half the table.

**Why the planner ignores your index.** In rough order of frequency:

1. **Too many rows match.** Reading most of the table through random I/O is slower than one sequential pass. This is correct behaviour.
2. **The query does not match the index.** A function on the column (`lower(email)`), a type mismatch (comparing a `bigint` column to a `numeric` parameter), or a missing leading column in a composite index.
3. **Stale or missing statistics.** After a bulk load and before `ANALYZE`.
4. **The table is tiny.** A 3-page table is faster to scan than to look up.
5. **Correlated columns.** The planner assumes conditions are independent and multiplies selectivities. If `city` and `venue_id` are related, it underestimates. `CREATE STATISTICS` with `dependencies` or `mcv` fixes this.

To test whether an index *could* be used, disable seq scans in your session only: `SET enable_seqscan = off;` then `EXPLAIN`. If the plan still does not use the index, the query cannot match it. Never set this in production.

**Pitfalls**

- Reading "it uses a Seq Scan" as a bug. On small tables or broad filters it is the right plan.
- Forgetting `ANALYZE` after seeding, then drawing conclusions from the plans.
- Benchmarking on 100 rows. The planner behaves completely differently at 1M rows, which is why this week starts with a seed script.

## 4. Reading query plans

`EXPLAIN` shows the plan the planner *would* run with its estimates; `EXPLAIN (ANALYZE, BUFFERS)` actually runs the query and adds what really happened. Compare the two columns, estimate vs actual, and most performance problems explain themselves.

**The options you will use.**

- `EXPLAIN query` - plan and estimates only. Instant, safe on production.
- `EXPLAIN (ANALYZE, BUFFERS) query` - executes the query, adds actual time, actual rows, loops and page counts. Since PostgreSQL 18, `BUFFERS` is included automatically with `ANALYZE`; spelling it out keeps your commands working on 16 and 17.
- `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` - the form visualizers want.

`ANALYZE` really executes the statement. For `INSERT`/`UPDATE`/`DELETE`, wrap it: `BEGIN; EXPLAIN ANALYZE UPDATE ...; ROLLBACK;`.

**A real plan, before the index.** The output below is from a local PostgreSQL 16 run on the seeded capstone schema (50k events, 1M bookings). Treat the numbers as illustrative: yours will differ with hardware, cache and data. The query is the `GET /events` list.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, city, starts_at
FROM events
WHERE city = 'Almaty' AND starts_at >= '2026-06-01'
ORDER BY starts_at, id
LIMIT 20;
```

```
Limit  (cost=1582.50..1582.55 rows=20 width=34) (actual time=6.426..6.431 rows=20 loops=1)
  Buffers: shared hit=731
  ->  Sort  (cost=1582.50..1592.60 rows=4040 width=34) (actual time=6.425..6.428 rows=20 loops=1)
        Sort Key: starts_at, id
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=731
        ->  Seq Scan on events  (cost=0.00..1475.00 rows=4040 width=34) (actual time=0.007..5.682 rows=3961 loops=1)
              Filter: ((starts_at >= '2026-06-01 00:00:00+05'::timestamptz) AND (city = 'Almaty'::text))
              Rows Removed by Filter: 46039
              Buffers: shared hit=725
Planning Time: 0.078 ms
Execution Time: 6.451 ms
```

Read it from the innermost node outwards (bottom up), because data flows from children to parents.

1. **`Seq Scan on events`** read all 725 pages (`shared hit=725`: every page was already in shared buffers; `read=` would mean fetched from the OS or disk). It kept 3,961 rows and threw away 46,039 (`Rows Removed by Filter`). Discarding 92% of what you read is the classic sign of a missing index.
2. **Estimate vs actual:** `rows=4040` estimated, `rows=3961` actual. Within a few percent, so statistics are healthy. The plan is bad because of a missing index, not a misestimate.
3. **`Sort`** with `top-N heapsort`: PostgreSQL knew it only needs 20 rows, so it kept a 20-row heap instead of sorting everything. Note the Sort's *startup* cost (1582.50) is almost equal to its total: it cannot emit the first row until it has seen all input.
4. **`Limit`** returned 20 rows. Total: 6.4 ms, 731 pages.

**The cost numbers.** `cost=startup..total` in planner units (about one sequential page read each). Startup is the work before the first row comes out; total assumes the node runs to completion. A parent's cost includes its children. `rows` is how many rows the node *emits* (after its filter), and `width` is average row size in bytes.

**The same query after the composite index** from section 5:

```
Limit  (cost=0.41..15.53 rows=20 width=34) (actual time=0.053..0.080 rows=20 loops=1)
  Buffers: shared hit=20 read=3
  ->  Index Scan using events_city_starts_id_idx on events  (cost=0.41..3054.30 rows=4040 width=34) (actual time=0.050..0.076 rows=20 loops=1)
        Index Cond: ((city = 'Almaty'::text) AND (starts_at >= '2026-06-01 00:00:00+05'::timestamptz))
        Buffers: shared hit=20 read=3
Execution Time: 0.106 ms
```

What changed: no Sort node, because the index already delivers rows in `starts_at, id` order. The filter moved into `Index Cond`, so non-matching rows are never read. 23 pages instead of 731, 0.1 ms instead of 6.4 ms. Notice also that the Index Scan's estimate says `rows=4040` and total cost 3054, but it actually produced 20 rows. That is not a misestimate: the `Limit` above it stopped it early. Costs are always printed as if the node ran to completion.

**Loops.** In a nested loop join the inner side runs once per outer row. `actual time` and `rows` are *per loop*. This plan joined events to bookings:

```
Nested Loop  (cost=10.32..430.15 rows=20 width=23) (actual time=0.072..8.227 rows=2530 loops=1)
  ->  Bitmap Heap Scan on events e  (cost=5.74..344.08 rows=1 width=19) (actual time=0.058..0.492 rows=126 loops=1)
        Recheck Cond: ((city = 'Almaty'::text) AND (starts_at < '2026-01-20 00:00:00+00'::timestamptz))
        Filter: ((id % '10'::bigint) = 1)
  ->  Bitmap Heap Scan on bookings b  (cost=4.59..85.86 rows=21 width=20) (actual time=0.034..0.059 rows=20 loops=126)
        Recheck Cond: (e.id = event_id)
```

The inner scan shows `rows=20 loops=126`: about 20 rows per run, 126 runs, so about 2,500 rows in total, which matches the top node's 2,530. Its real time is 0.059 ms x 126, about 7.4 ms.

**Spotting a misestimate.** Look at the events scan above: estimated `rows=1`, actual `rows=126`. The planner had no statistics for the expression `id % 10 = 1` and guessed a tiny selectivity. Off by 126x, it still chose a nested loop, which happened to be fine here. In real systems this pattern is how bad plans start: the planner thinks the outer side yields 1 row, picks a nested loop, and then runs the inner side 100,000 times. Rules of thumb:

- Compare `rows` estimated vs actual at every node, starting from the bottom. The *lowest* node that is off by 10x or more is usually the root cause; errors compound upward.
- Common causes: stale stats (run `ANALYZE`), expressions without stats (add an expression index, which gets its own statistics, or `CREATE STATISTICS`), correlated columns, and parameters with skewed values.

**Buffers.** `shared hit` = pages found in PostgreSQL's buffer cache; `read` = pages requested from the OS (page cache or disk); `dirtied`/`written` appear for writes. Buffers are a better metric than milliseconds when comparing two plans: time depends on whether the cache is warm, page counts mostly do not. Run a query twice and compare the second run.

**Tools.** Paste text or (better) JSON output into [explain.dalibo.com](https://explain.dalibo.com/). It draws the plan as a tree, highlights the slowest nodes and the worst misestimates. It stores submitted plans on its server for sharing, so for production plans use its standalone HTML build, offered on the site.

**Pitfalls**

- Optimizing a query from `EXPLAIN` alone. Estimates can be wrong; use `ANALYZE` on realistic data.
- Forgetting that `EXPLAIN ANALYZE` executes writes.
- Comparing a cold-cache run with a warm-cache run. Compare buffers, or warm up first.
- Forgetting to multiply by `loops` when hunting for the slow node.
- Testing with literal values when the app sends parameters. Under a generic plan, a skewed value can get a different plan. `EXPLAIN (GENERIC_PLAN)` shows it.

## 5. Composite indexes and keyset pagination

A composite (multicolumn) B-tree is sorted by the first column, then by the second within equal first values, and so on, exactly like a phone book sorted by surname, then first name. Column order decides which queries it can serve.

**The leftmost-prefix rule.** Take `CREATE INDEX ON events (city, starts_at, id)`. Inside the tree, all `Almaty` entries are contiguous and sorted by `starts_at`; inside equal `starts_at` they are sorted by `id`. So:

| Query | Can the index narrow the scan? |
| --- | --- |
| `WHERE city = 'Almaty'` | Yes, one contiguous slice |
| `WHERE city = 'Almaty' AND starts_at >= X` | Yes, a slice inside the slice |
| `WHERE city = 'Almaty' ORDER BY starts_at, id LIMIT 20` | Yes, and no sort needed |
| `WHERE starts_at >= X` (no city) | Not efficiently: `starts_at` values are spread across every city |
| `WHERE id = 5` | No |

On my data, the fourth query ignored the index and did a Seq Scan plus Sort. The manual states the precise rule: equality conditions on the leading columns, plus an inequality on the first column without an equality, bound the part of the index that is read. Conditions on later columns are still checked inside the index (saving heap visits) but do not shrink the range.

> PostgreSQL 18 added **B-tree skip scan**: if the leading column has very few distinct values, the planner can probe each value in turn, so `WHERE starts_at >= X` could use `(status, starts_at)` when `status` has three values. Treat it as a bonus, not as a design tool. With 10 cities it might kick in; with 10,000 it will not.

**Equality first, then range.** Use The Index, Luke sums up the rule as "index for equality first—then for ranges." Why: with `(city, starts_at)` and `city = 'Almaty' AND starts_at >= X`, the matches form one contiguous run of leaves. With `(starts_at, city)`, the range on `starts_at` comes first, so the scan reads every city's events after X and filters `city` row by row in the index. Same result, many more index pages.

The third consideration is sort order. If the query has `ORDER BY`, the columns after the equality columns should match the `ORDER BY` columns and direction. Then the index produces rows already sorted, and `LIMIT` can stop early.

**Why `id` is in the index.** `starts_at` is not unique: two events can start at the same moment. For pagination you need a total order, so you add a unique tie-breaker (the primary key) to both `ORDER BY` and the index.

**OFFSET pagination and why it degrades.** `ORDER BY starts_at, id OFFSET 4000 LIMIT 20` must produce and discard 4,000 rows to return 20. The work grows with page depth. Pages also shift when rows are inserted, so a user can see duplicates or miss rows while scrolling. On my data, page 201 for Almaty took 8.3 ms and sorted 4,020 rows. Production tables with millions of rows make it much worse.

**Keyset (cursor) pagination.** Instead of "skip N rows", say "give me rows after the last one I saw". The client sends back the last row's `(starts_at, id)` as an opaque cursor:

```sql
SELECT id, title, city, starts_at
FROM events
WHERE city = :city
  AND (starts_at, id) > (:last_starts_at, :last_id)
ORDER BY starts_at, id
LIMIT 20;
```

The row-value comparison `(a, b) > (x, y)` means "a > x, or a = x and b > y", which is exactly the index order. PostgreSQL turns it into an `Index Cond`, so the scan starts directly at the cursor position. On my data, the same deep page (position 4,000) via keyset read 23 buffers and took 0.14 ms, against 753 buffers and 8.3 ms for OFFSET. It stays constant at any depth. The full treatment is in Use The Index, Luke chapter 7, ["Partial Results" > "Paging Through Results"](https://use-the-index-luke.com/sql/partial-results/fetch-next-page).

The trade-offs: no "jump to page 37", and going backwards means flipping both the comparison and the sort direction. For an infinite-scroll events list, neither matters.

**In SQLAlchemy 2.0:**

```python
from sqlalchemy import Index, select, tuple_

class Event(Base):
    __tablename__ = "events"
    # ... columns ...
    __table_args__ = (
        Index("ix_events_city_starts_at_id", "city", "starts_at", "id"),
    )

def list_events_stmt(city: str, after: tuple[datetime, int] | None, limit: int = 20):
    stmt = select(Event).where(Event.city == city)
    if after is not None:
        stmt = stmt.where(tuple_(Event.starts_at, Event.id) > tuple_(*after))
    return stmt.order_by(Event.starts_at, Event.id).limit(limit)
```

Encode the cursor as base64 of `starts_at.isoformat()` plus `id`, so clients treat it as opaque. Fetch `limit + 1` rows to know whether there is a next page.

**Pitfalls**

- Building one index per column and hoping the planner combines them. A bitmap AND of `ix_city` and `ix_starts_at` can filter, but cannot return rows in order, so you still pay for a sort.
- An `ORDER BY` that does not match the index direction or includes a column not in the index. Then the Sort node comes back.
- A cursor on a non-unique column alone (`starts_at > :last`). You silently skip rows that share the timestamp.
- Adding columns "just in case". A wider index is a bigger, slower index. Each column must serve a filter, a sort or an index-only scan.

## 6. Special-purpose B-tree indexes

Four variations of the plain B-tree solve most real-world cases: index fewer rows (partial), index a computed value (expression), carry extra columns to skip the heap (covering), or enforce a rule (unique).

### Partial indexes

A partial index has a `WHERE` clause and contains entries only for rows that satisfy it. Rows outside the predicate are not in the index at all, so they also cost nothing to maintain on insert or update.

```sql
-- The public listing only ever shows active events
CREATE INDEX ix_events_active_city_starts
    ON events (city, starts_at, id)
    WHERE status = 'active';
```

**When the planner uses it.** The query's `WHERE` must *imply* the index predicate, and the planner checks this at planning time with simple logic, not a theorem prover. In practice: repeat the same condition literally. `WHERE status = 'active' AND city = ...` works. `WHERE status = :status` with a bound parameter may not, because a generic plan cannot know the value is `'active'`. Hard-code the literal in the query text for the listing endpoint.

**When it pays off.** The smaller the slice, the bigger the win. In my seed data 82% of events are active, so the partial index was only 18% smaller (1.75 MB vs 2.1 MB). Real gains come from predicates like "unprocessed outbox rows" or "pending bookings", where the slice is 1%. A good capstone example:

```sql
-- The notification worker polls for pending bookings. 1-2% of rows.
CREATE INDEX ix_bookings_pending ON bookings (created_at) WHERE status = 'pending';
```

**Partial unique indexes** enforce a rule over a subset. For example, one active booking per user per event, while cancelled bookings can repeat:

```sql
CREATE UNIQUE INDEX uq_bookings_user_event_active
    ON bookings (user_id, event_id)
    WHERE status <> 'cancelled';
```

### Expression indexes

An index on a function result, such as `lower(email)`, stores the computed value as the key. The planner uses it only when the query contains the same expression.

```sql
CREATE UNIQUE INDEX uq_users_email_lower ON users (lower(email));

SELECT id FROM users WHERE lower(email) = lower(:email);  -- uses it
SELECT id FROM users WHERE email = :email;               -- does not
```

On my 100k users, the `lower(email)` lookup went from a Seq Scan over 1,022 pages (42 ms, the function ran 100k times) to 4 pages (0.06 ms). Making it `UNIQUE` also closes a real bug: without it, `Mathew@x.kz` and `mathew@x.kz` can register as two accounts.

The function must be `IMMUTABLE` (same input, same output forever). `lower()` qualifies. `now()` does not, and casts of `timestamptz` to `date` do not either, because they depend on the session time zone. A bonus: PostgreSQL collects statistics on indexed expressions during `ANALYZE`, which fixes estimates for queries that filter on that expression. An alternative for case-insensitive text is the `citext` extension or a nondeterministic collation, but the expression index is the simplest to reason about.

### Covering indexes and index-only scans

An index-only scan answers a query from the index without touching the heap. Two conditions must hold. First, every column the query reads must be in the index. Second, the heap page must be marked **all-visible** in the visibility map.

Why the second condition: visibility (`xmin`/`xmax`) lives only in the heap. The visibility map keeps one bit per heap page meaning "every tuple here is visible to everyone". `VACUUM` sets the bit; any write to the page clears it. For an all-visible page, the scan trusts the index entry. For any other page, it still fetches the heap tuple. That fallback is counted as `Heap Fetches` in the plan.

`INCLUDE` adds non-key payload columns to the leaf entries. They are not part of the sort order and cannot be searched, but they make an index-only scan possible:

```sql
-- "My bookings" page: filter by user, newest first, show a few columns
CREATE INDEX ix_bookings_user_created
    ON bookings (user_id, created_at DESC)
    INCLUDE (event_id, seats, status);
```

After a `VACUUM`, my plan for that page was `Index Only Scan ... Heap Fetches: 0`, 7 buffers. Why `INCLUDE` instead of adding the columns to the key? Key columns are also stored in internal pages and define the order; payload columns live only in leaves. For a unique index, `INCLUDE` matters more: uniqueness applies only to the key columns.

Use it sparingly. Payload makes the index bigger, and on a frequently updated table the visibility map is rarely set, so you pay the size and still hit the heap.

### Unique indexes

A unique B-tree rejects a second entry with an equal key. `PRIMARY KEY` and `UNIQUE` constraints create one automatically, so do not add a second plain index on the same columns. Two details worth knowing:

- By default `NULL`s are distinct, so a unique index allows many `NULL` rows. PostgreSQL 15+ supports `NULLS NOT DISTINCT` to allow only one.
- Prefer a `UNIQUE` constraint when the rule is about the data model (it shows up in `\d` and can be referenced by foreign keys). Use a unique *index* when you need what constraints cannot express: partial or expression uniqueness.

### In SQLAlchemy 2.0

```python
from sqlalchemy import Index, func, text

class Event(Base):
    __tablename__ = "events"
    __table_args__ = (
        Index(
            "ix_events_active_city_starts",
            "city", "starts_at", "id",
            postgresql_where=text("status = 'active'"),
        ),
    )

class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        Index("uq_users_email_lower", func.lower(text("email")), unique=True),
    )

class Booking(Base):
    __tablename__ = "bookings"
    __table_args__ = (
        Index(
            "ix_bookings_user_created",
            "user_id", text("created_at DESC"),
            postgresql_include=["event_id", "seats", "status"],
        ),
    )
```

Check what Alembic autogenerate emits for expression indexes. Comparison of functional indexes has historically been unreliable, so review the generated migration rather than trusting it.

**Pitfalls**

- Partial index predicate not matched by the query text, so it is silently unused. Always confirm with `EXPLAIN`.
- Many partial indexes, one per category, as a poor man's partitioning. The manual explicitly advises one composite index with the category first instead.
- Expression index on `lower(email)` while the ORM query uses `ilike`. Different expression, no index use.
- Expecting `Heap Fetches: 0` on a table that is constantly updated. Check autovacuum is keeping up.
- Wide `INCLUDE` columns (text, jsonb). Index tuples have a size limit (roughly a third of a page) and inserts fail past it.

## 7. Other index types: Hash, GIN, GiST, BRIN

B-tree handles scalar values with a total order. When the question is "which rows *contain* X", "which shapes *overlap*", or "which *region of the table* holds this date", a different structure answers it far better.

**Hash.** Stores a 32-bit hash of the value and supports only `=`. It is crash-safe and replicated since PostgreSQL 10. It can be smaller than a B-tree for long keys (a URL, a token), because it never stores the key itself. But it cannot do ranges, sorting, uniqueness or multicolumn keys. In practice a B-tree is almost always good enough; reach for hash only after measuring.

**GIN (Generalized Inverted Index).** The structure behind a book's index: for every *element* (a word, an array item, a jsonb key or value) it stores the list of rows that contain it. A query like "tags contain music AND vip" looks up two posting lists and intersects them. It is ideal for:

- `jsonb` containment `@>` and key existence `?`.
- Arrays: `@>`, `<@`, `&&` (overlap).
- Full-text search on `tsvector` with `@@`.
- Trigram similarity (`LIKE '%abc%'`) via the `pg_trgm` extension.

For `jsonb` there are two operator classes. The default `jsonb_ops` indexes every key and value and supports `?`, `?|`, `?&`, `@>`, `@?`, `@@`. `jsonb_path_ops` hashes paths to values. It is usually much smaller and faster for `@>`, but cannot answer key-existence (`?`). I confirmed it on the seeded data: with a `jsonb_path_ops` index, `tags @> '["music","outdoor"]'` used the index, while `tags ? 'music'` fell back to a Seq Scan.

```sql
CREATE INDEX ix_events_tags ON events USING gin (tags jsonb_path_ops);

-- uses it: is "music" an element of the tags array?
SELECT id, title FROM events WHERE tags @> '["music"]';
```

GIN has a write cost: one row with 5 tags creates 5 index entries. To soften that, GIN buffers new entries in a "pending list" (`fastupdate`) and merges them later, which makes inserts cheaper but can make some searches slower until the list is flushed. GIN never supports index-only scans, so the planner always uses a bitmap heap scan with it.

**GiST (Generalized Search Tree).** A balanced tree whose internal entries are bounding "summaries" (for example a bounding box) that may overlap. It answers "overlaps", "contains", "is near" for geometry, ranges (`tstzrange`), PostGIS, and full-text. Two features matter for backends:

- **Nearest-neighbour ordering:** `ORDER BY location <-> point '(71.43,51.13)' LIMIT 10` for "events near me".
- **Exclusion constraints:** "no two bookings of the same room overlap in time", which a unique index cannot express.

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE venue_slots ADD CONSTRAINT no_overlap
    EXCLUDE USING gist (venue_id WITH =, during WITH &&);
```

SP-GiST is a sibling for space-partitioning structures (quadtrees, radix trees), useful for points and IP ranges.

**BRIN (Block Range Index).** Instead of one entry per row, BRIN stores one summary per range of heap pages (128 pages by default): the minimum and maximum value in that range. A query for March 1 skips every range whose min-max does not include March 1, then reads the remaining ranges in full and rechecks each row. It only works if values are correlated with physical order, such as `created_at` on an append-only table.

On my 1M bookings (inserted in `created_at` order), a B-tree on `created_at` was 21 MB; the BRIN index was 24 kB, about 900 times smaller. A one-day query read 133 buffers in 1.5 ms through it, with `Heap Blocks: lossy=128` and `Rows Removed by Index Recheck: 12030`: it read whole block ranges and discarded the non-matching rows. A B-tree would be faster for small lookups; BRIN wins on huge tables where a B-tree costs gigabytes. Updates and deletes that scatter old values across the table destroy its usefulness.

**When to use which.**

| Type | Answers | Typical column | Capstone use | Avoid when |
| --- | --- | --- | --- | --- |
| B-tree | `= < > BETWEEN IN`, sort, `LIKE 'x%'`, unique | ids, timestamps, names, status | almost everything | values are multi-element (arrays, jsonb) |
| Hash | `=` only | long opaque keys | rarely; maybe an API token lookup | you need ranges, ordering, uniqueness |
| GIN | element contains / overlaps / exists, full-text | `jsonb`, arrays, `tsvector` | `events.tags` | heavy write load on many-element rows |
| GiST | overlap, containment, distance (KNN), exclusion | ranges, geometry, PostGIS | venue time-slot overlap, events near me | plain equality on scalars |
| BRIN | ranges on physically ordered data | `created_at` on append-only logs | `bookings.created_at` for reports, an audit log | rows are updated or arrive out of order |

**Pitfalls**

- Picking `jsonb_path_ops` and then querying with `?`. The index is silently unused.
- Writing `tags->>'x' = 'y'` while the GIN index is on `tags`. GIN serves the containment operators, not extracted text. Either use `@>` or create a B-tree expression index on `(tags->>'x')`.
- Using BRIN on a table whose physical order does not follow the column. Check `pg_stats.correlation` first; near 1 or -1 is good.
- Expecting GIN to help `ORDER BY`. It has no order.

## 8. What indexes cost

Every index speeds up some reads and slows down every write to its table. On my machine, inserting 500k bookings took 0.6 s into a table with no indexes and 7.2 s into one with five, and the table plus indexes grew from 37 MB to 121 MB.

**Write amplification.** An `INSERT` writes one heap tuple plus one entry in *every* index on the table. Each of those is a B-tree descent, a possible page split, and WAL to write. Random keys (like `user_id` or a UUIDv4) touch random leaf pages, which is much worse for cache and WAL than appending to the right edge (like an identity `id` or `created_at`). A `DELETE` does not touch indexes immediately, but leaves dead entries for `VACUUM` to remove.

**Updates and HOT.** Recall from section 1 that an `UPDATE` writes a new tuple with a new TID. Normally every index then needs a new entry pointing at it, even indexes on columns you did not change. HOT (heap-only tuple) updates avoid that. When **no indexed column changed** and **the new version fits on the same heap page**, PostgreSQL chains the new tuple to the old one inside the page. Indexes keep pointing at the old line pointer, which redirects to the newest version. No index writes at all, and the old versions can be pruned during normal page access, without waiting for `VACUUM`.

This matters directly for the capstone. `events.seats_left` is decremented on every booking. I measured 5,000 scattered updates of `seats_left` with `fillfactor = 85`:

| Setup | Updates | HOT updates |
| --- | --- | --- |
| No index on `seats_left` | 5,000 | 5,000 (100%) |
| With `CREATE INDEX ON events (seats_left)` | 5,000 | 0 (0%) |

One extra index turned every cheap in-page update into a full update of *all* indexes on `events`. Rules that follow:

- Do not index hot-update columns (counters, `updated_at`, `last_seen_at`, `seats_left`) unless a query truly needs it.
- Lower `fillfactor` (e.g. 85-90) on update-heavy tables to leave room on each page for the new versions. Freshly bulk-loaded pages are 100% full; my first test on such pages got 0 HOT updates out of 5,000 even without the extra index, until I set a fillfactor and rewrote the table.
- BRIN is a "summarizing" index and does not block HOT.
- Monitor `n_tup_hot_upd / n_tup_upd` in `pg_stat_user_tables`.

**Bloat.** Dead tuples and dead index entries occupy space until `VACUUM` marks it reusable. Plain `VACUUM` does not shrink files; it makes space reusable within them. If deletes or non-HOT updates outpace vacuum, tables and especially indexes grow with empty or half-empty pages. That is bloat: more pages to read for the same data, and a less effective cache. B-trees mitigate this since PostgreSQL 13-14 with deduplication and "bottom-up deletion", which removes obsolete versions from a leaf page before it splits.

**VACUUM and autovacuum basics.** `VACUUM` removes dead tuples and their index entries, updates the visibility map (needed for index-only scans), and freezes old rows to prevent transaction ID wraparound. `ANALYZE` refreshes planner statistics. Autovacuum runs both in the background, by default after roughly 20% of a table's rows are dead (vacuum) or 10% have changed (analyze), plus a small fixed threshold. On large, hot tables 20% is a lot; lower the scale factor per table:

```sql
ALTER TABLE bookings SET (autovacuum_vacuum_scale_factor = 0.02,
                          autovacuum_analyze_scale_factor = 0.02);
```

`VACUUM FULL` rewrites the table and its indexes compactly, but takes an `ACCESS EXCLUSIVE` lock for the whole time. On production use `REINDEX CONCURRENTLY` for bloated indexes (next section) or tools like `pg_repack` for tables.

**Finding unused indexes.** PostgreSQL counts scans per index:

```sql
SELECT s.relname AS table_name,
       s.indexrelname AS index_name,
       s.idx_scan,
       s.last_idx_scan,                          -- PostgreSQL 16+
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE NOT i.indisunique          -- keep PKs and unique constraints
ORDER BY s.idx_scan, pg_relation_size(s.indexrelid) DESC;
```

An index with `idx_scan = 0` over weeks of real traffic is a candidate to drop. Before dropping, check: counters reset when stats are reset (and per server, so check replicas too, which serve their own reads); the index may back a rare but important monthly report; unique indexes enforce correctness even if never scanned. Also look for duplicates: an index on `(user_id)` is redundant when `(user_id, created_at)` exists, since the composite serves the same lookups.

**Pitfalls**

- "Index every foreign key and every filter column" by reflex. Each index is a tax on every write. Index what your queries prove they need.
- Indexing `updated_at` or a counter, then wondering why update throughput dropped and the table bloats.
- Running `VACUUM FULL` on production to fix bloat and locking the table for minutes.
- Dropping an "unused" index right after a stats reset or a restart.

## 9. Changing indexes safely in production

A plain `CREATE INDEX` blocks every `INSERT`, `UPDATE` and `DELETE` on the table until it finishes; on a busy `bookings` table that is an outage. `CREATE INDEX CONCURRENTLY` builds the index while writes continue, at the price of a slower build and a few sharp edges.

**What plain CREATE INDEX does.** It takes a `SHARE` lock on the table: reads continue, writes wait. Building an index over 100M rows can take many minutes, and every booking request queues behind the lock. Worse, those queued writers then block readers that arrive after them (lock queueing is covered in the transactions doc).

**What CONCURRENTLY does differently.** It takes a weaker `SHARE UPDATE EXCLUSIVE` lock that does not conflict with normal writes, and builds the index in phases:

1. Register the index in the catalog as not ready, and wait for every transaction that might write the table without knowing about it to finish.
2. First scan of the table: build the index from a snapshot. Mark it ready for inserts, so new writes now maintain it.
3. Second scan: add the rows that changed during the first scan. Wait again for older transactions.
4. Mark the index valid. The planner may now use it.

Two table scans and several waits mean it is 2-3 times slower and adds I/O load. A single long-running transaction (a stuck analytics query, an idle-in-transaction session) can make it wait indefinitely in step 1 or 3.

**Sharp edges.**

- **It cannot run inside a transaction block.** PostgreSQL rejects it with `CREATE INDEX CONCURRENTLY cannot run inside a transaction block`. This is the edge that bites in migrations, because Alembic wraps each migration in a transaction on PostgreSQL.
- **Failure leaves an INVALID index.** If the build fails (deadlock, a duplicate in a unique build, a cancelled statement), the index remains in the catalog with `indisvalid = false`. The planner ignores it, but every write still maintains it. I reproduced this locally: a `CREATE UNIQUE INDEX CONCURRENTLY` on `lower(email)` with an existing duplicate failed and left an invalid index. Fix: `DROP INDEX CONCURRENTLY` it, fix the cause, retry. Find leftovers with:

```sql
SELECT indexrelid::regclass AS index_name, indrelid::regclass AS table_name
FROM pg_index
WHERE NOT indisvalid;
```

- **Unique builds enforce early.** During the second phase, the unfinished unique index already rejects conflicting writes from other sessions.
- **Partitioned tables** do not support it directly. Build concurrently on each partition, then attach.
- **Set a lock timeout.** Even the weak lock must queue. `SET lock_timeout = '5s'` makes the migration fail fast instead of waiting behind something unexpected.

**Doing it in an Alembic migration.** Use the migration context's `autocommit_block()`, which commits the current transaction and runs the block on an autocommit connection:

```python
"""add partial index for pending bookings"""
from alembic import op

revision = "a1b2c3d4e5f6"
down_revision = "0f9e8d7c6b5a"

def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("SET lock_timeout = '5s'")
        op.create_index(
            "ix_bookings_pending",
            "bookings",
            ["created_at"],
            postgresql_where="status = 'pending'",
            postgresql_concurrently=True,
            if_not_exists=True,
        )

def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.drop_index(
            "ix_bookings_pending",
            table_name="bookings",
            postgresql_concurrently=True,
            if_exists=True,
        )
```

Things to know about this pattern:

- Anything the migration did *before* the block is committed unconditionally. Keep concurrent index builds in their own migration file, and set `transaction_per_migration=True` in `env.py` so each migration is its own unit.
- `if_not_exists` makes a retry after a partial failure safe. It does not detect an INVALID leftover with the same name, though: `IF NOT EXISTS` sees the name and skips. After a failure, drop the invalid index first.
- Dialect options like `postgresql_concurrently` are passed through to SQLAlchemy's `Index`, which renders `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...`. Run `alembic upgrade head --sql` to see the exact SQL before applying.
- Autogenerate will never add `CONCURRENTLY` for you. Edit the generated migration by hand.

**REINDEX CONCURRENTLY.** For a bloated or corrupted index, `REINDEX INDEX CONCURRENTLY ix_name;` builds a fresh copy alongside the old one, swaps them, and drops the old, without blocking writes. It has the same rules: not in a transaction block, more total work. If it fails, it leaves an invalid index whose name ends in `_ccnew` (drop it and retry) or `_ccold` (the rebuild succeeded; just drop the old one).

**Dropping.** `DROP INDEX` takes an `ACCESS EXCLUSIVE` lock, briefly, but it must wait for all queries using the table. `DROP INDEX CONCURRENTLY` avoids that and is the safe default in production.

**Pitfalls**

- Shipping `op.create_index(...)` from autogenerate unchanged on a large table. Fine in dev with 1,000 rows, an outage in production.
- Mixing a column change and a concurrent index in one migration. The autocommit block commits the column change before the index build; a failure then leaves you half-migrated.
- Not checking for INVALID indexes after a failed deploy. They slow every write and serve no reads.
- Running a concurrent build while a long transaction is open and assuming it hung. Check `pg_stat_activity` for what it waits on.

## Apply it to the capstone

This week's build is a measurement loop: seed realistic volume, capture plans, add one index at a time, and record what changed. Keep a `docs/perf-week3.md` table in the repo with the query, plan shape, buffers and time, before and after.

- [ ] Seed script: \~50k events, 1M bookings
- [ ] `EXPLAIN (ANALYZE, BUFFERS)` on every list query
- [ ] Composite index for keyset pagination on `GET /events`, with before/after timings
- [ ] Partial index, expression index on `lower(email)`, GIN on `events.tags`
- [ ] Insert throughput with 0 vs 5 indexes
- [ ] One index via an Alembic migration with `CREATE INDEX CONCURRENTLY`

### 1. Seed script

Do not insert 1M rows through the ORM one by one; that takes many minutes. Two fast options:

- **Server-side `generate_series`.** One `INSERT ... SELECT` per table; the data never leaves the database. On my laptop-class sandbox, 100k users + 50k events + 1M bookings took about 33 seconds in total.
- **`COPY FROM STDIN`** from Python, when you want realistic Faker data. With psycopg 3, `cursor.copy("COPY bookings (event_id, user_id, seats, status, created_at) FROM STDIN")` and `copy.write_row(...)` streams rows in bulk.

A sketch of the `generate_series` shape (fill in the rest yourself):

```sql
INSERT INTO bookings (event_id, user_id, seats, status, created_at)
SELECT 1 + (random() * 49999)::int,
       1 + (random() * 99999)::int,
       1 + (g % 4),
       CASE WHEN g % 10 = 0 THEN 'cancelled'
            WHEN g % 50 = 0 THEN 'pending'
            ELSE 'confirmed' END,
       timestamptz '2026-01-01' + (g / 1e6) * interval '600 days'
FROM generate_series(1, 1000000) AS g;
```

Hints: make the data skewed, not uniform. Real cities are not equally popular, and a few events sell out. Uniform data hides misestimates. Load with the minimum indexes (PK only), then create the rest, which is faster than maintaining them during the load. Finish with `VACUUM ANALYZE` so statistics and the visibility map are fresh. Wrap it as `python -m app.scripts.seed` runnable in Docker Compose.

### 2. Plans for every list query

List the endpoints that return collections: `GET /events`, `GET /events/{id}/bookings`, `GET /me/bookings`, any admin list. For each, capture the exact SQL SQLAlchemy emits (`echo=True`, or `str(stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))`) and run `EXPLAIN (ANALYZE, BUFFERS)` on it in `psql`. For each plan record: top node shape, Seq Scan or Index Scan, any Sort node, rows estimated vs actual at the bottom node, total buffers, execution time. Then answer one question per plan: what is the bottleneck? Use the reading order from section 4.

Optional but useful: a small pytest helper that runs `EXPLAIN (FORMAT JSON)` for a statement and asserts the plan contains no `Seq Scan` on `bookings`. This catches regressions when someone changes a query.

### 3. Keyset pagination on GET /events

The endpoint filters by `city` and a from-date, orders by `starts_at, id`, and returns a cursor. Work through it:

1. Implement OFFSET first (if you have not) and capture the plan for page 1 and page 200.
2. Design the index using section 5's rules: which columns are equality, which is the range, what is the sort order? Decide whether the listing only shows `status = 'active'` events; if so, the partial form is the natural choice.
3. Switch to the row-value comparison and capture the same two pages again. You should see the Sort node disappear and buffers stop growing with depth.
4. Think about the edge: what does the endpoint do when `city` is not given? The index cannot serve that query efficiently. Decide whether `city` is required or whether you need a second index on `(starts_at, id)`.

Cursor sketch, deliberately incomplete:

```python
def encode_cursor(starts_at: datetime, event_id: int) -> str:
    raw = f"{starts_at.isoformat()}|{event_id}".encode()
    return base64.urlsafe_b64encode(raw).decode()

# decode_cursor(): reverse it, validate, raise 400 on garbage
# in the query: tuple_(Event.starts_at, Event.id) > tuple_(cursor_ts, cursor_id)
```

My reference numbers on the seeded data, to sanity-check yours: page 1 went from 731 buffers / 6.4 ms (Seq Scan + Sort) to 23 buffers / 0.1 ms. A page 4,000 rows deep took 753 buffers / 8.3 ms with OFFSET and 23 buffers / 0.14 ms with keyset.

### 4. Partial, expression and GIN indexes

- **Partial:** the notification worker's "pending bookings" poll, or the active-only events listing. Prove the planner picks it, then write the query with a bound parameter for `status` and see whether it still does.
- **Expression on `lower(email)`:** make it `UNIQUE`, and change the login and registration queries to `lower(email) = lower(:email)`. Test that registering `A@x.kz` after `a@x.kz` fails with an `IntegrityError` you translate into a 409.
- **GIN on `events.tags`:** add `tags jsonb NOT NULL DEFAULT '[]'` (or `text[]`), a `?tag=music` filter, and implement it with `@>`. Pick `jsonb_ops` or `jsonb_path_ops` and write down why.

For each, record index size (`pg_relation_size`) next to the speed-up.

### 5. Insert throughput with 0 vs 5 indexes

Create two copies of `bookings` with `CREATE TABLE b0 (LIKE bookings INCLUDING DEFAULTS)`; give one five realistic indexes. Insert the same 500k rows into each with `\timing on`. My result: 0.6 s vs 7.2 s, and 37 MB vs 121 MB on disk. Then go further than I did: measure from the API side with a load tool (for example `locust` or `k6`) hitting `POST /bookings`, because the real cost includes WAL and fsync per committed transaction. Also look at `n_tup_hot_upd` for `events` after a load test: are your `seats_left` decrements HOT?

### 6. One index through Alembic, concurrently

Use the migration shape from section 9. To make it realistic, run a write loop against `bookings` in another terminal while the migration runs and confirm it never blocks. Then break it on purpose: create a duplicate email and run a unique concurrent build. Observe the INVALID index in `\d users`, write a down-and-up recovery, and add the `pg_index WHERE NOT indisvalid` check to your deploy runbook.

### What to hand in at the end of the week

A table with one row per query: query name, index added, plan before and after, buffers before and after, p50 time before and after, index size. Plus one sentence per index on why it exists. If you cannot write that sentence, drop the index.

## Check yourself

Answer out loud before opening the answers. These are phrased the way interviewers ask them.

1. You run `SELECT * FROM bookings WHERE event_id = 42` and the index on `event_id` is used. Walk through every page PostgreSQL touches, and say which part dominates the cost.
2. A teammate adds an index on `bookings.status` (three values, 90% `confirmed`). The planner never uses it for `status = 'confirmed'`. Why, and when would it use it?
3. What is the difference between an Index Scan and a Bitmap Heap Scan, and when does the planner prefer each?
4. A plan shows `Index Only Scan` but `Heap Fetches: 48000`. What does that mean and how do you fix it?
5. You have an index on `(city, starts_at)`. Which of these use it efficiently: `WHERE city = ?`, `WHERE starts_at > ?`, `WHERE city = ? ORDER BY starts_at LIMIT 20`, `WHERE city IN (?, ?) AND starts_at > ?`?
6. Why is `OFFSET`-based pagination slow on deep pages, and how does keyset pagination fix it? Why must the cursor include `id`?
7. In `EXPLAIN ANALYZE` an inner node shows `actual time=0.05..0.40 rows=3 loops=20000`. How much time did it really take, and what plan problem might this indicate?
8. A login query `WHERE email = :email` is fast, but users complain they cannot log in with different capitalization. You change it to `lower(email) = lower(:email)` and it becomes slow. Fix it properly.
9. What is a HOT update, and how can adding one index make `UPDATE events SET seats_left = seats_left - 1` slower?
10. When would you choose a BRIN index over a B-tree, and when would BRIN be useless?
11. Your migration runs `CREATE INDEX CONCURRENTLY` and fails with "cannot run inside a transaction block". Why, and how do you fix it in Alembic? What happens if the build fails halfway?
12. How do you find indexes that can be dropped, and what do you check before dropping one?

## Answers

1. Descend the B-tree: root, internal level(s), leaf (3-4 pages). Read the matching leaf entries, maybe stepping to the next leaf. Then fetch each heap page that a TID points to and check visibility. With \~20 bookings per event scattered over the table, that is \~20 heap pages. The heap fetches dominate; the descent is a fixed handful of pages.
2. Selectivity. 90% of rows match, so reading them through random index lookups costs more than one sequential pass. The planner would use it for the rare values (`pending`), where statistics show a small frequency. Better: a partial index `WHERE status = 'pending'` if that is the query that matters.
3. An Index Scan fetches heap tuples in index order, one by one, and preserves sort order; good for few rows or `ORDER BY ... LIMIT`. A bitmap scan first collects all matching TIDs, sorts them by page, then reads each heap page once in physical order; good for a medium number of rows and for combining indexes with AND/OR, but it loses the index order.
4. 48,000 times the heap page was not marked all-visible, so PostgreSQL had to visit the heap to check visibility, which defeats the purpose. Fix: make sure `VACUUM` runs often enough on that table (autovacuum tuning per table, or a manual `VACUUM` after bulk loads). On a table that is constantly updated, an index-only scan may never be fully effective.
5. `city = ?`: yes (leading column). `starts_at > ?`: not efficiently; the leading column is not constrained (PostgreSQL 18 skip scan may help only if there are very few cities). `city = ? ORDER BY starts_at LIMIT 20`: yes, best case, no sort and early stop. `city IN (?, ?) AND starts_at > ?`: yes for filtering, as two index ranges, but if you also `ORDER BY starts_at` across both cities, a sort or merge is needed.
6. `OFFSET n` makes the database produce and discard n rows before returning the page, so work grows linearly with depth; inserts also shift page boundaries. Keyset uses `WHERE (starts_at, id) > (last_ts, last_id)`, which becomes an index range start, so every page costs the same. `id` makes the order total; without it, rows with the same `starts_at` are skipped or repeated at page boundaries.
7. `actual time` and `rows` are per loop: about 0.40 ms x 20,000 = 8 seconds, and 60,000 rows. It often means the planner underestimated the outer side's row count and chose a nested loop that should have been a hash join. Look for the misestimate in the outer node.
8. Create a unique expression index `ON users (lower(email))`, query with exactly `lower(email) = lower(:email)`, and deploy it with `CREATE UNIQUE INDEX CONCURRENTLY`. Clean up existing case-duplicates first or the build fails and leaves an INVALID index.
9. A HOT update writes the new row version on the same heap page and adds no index entries, because no indexed column changed. If you index `seats_left`, every decrement changes an indexed column, so HOT is impossible: each update now inserts a new entry into *every* index on `events`, generates more WAL and creates index bloat.
10. BRIN fits huge tables whose physical order follows the column, such as `created_at` on an append-only log: it is tiny (kilobytes vs gigabytes) and skips block ranges by min/max. It is useless when values are scattered physically (random inserts, frequent updates), because every block range's min/max covers almost everything.
11. PostgreSQL forbids it inside a transaction block, and Alembic wraps each migration in one. Wrap the call in `with op.get_context().autocommit_block():` and pass `postgresql_concurrently=True`. Keep it in its own migration, since the block commits prior work. If the build fails, an INVALID index remains: it is maintained on writes but never used. Find it in `pg_index WHERE NOT indisvalid`, drop it concurrently, fix the cause, retry.
12. Query `pg_stat_user_indexes` for `idx_scan = 0` (and `last_idx_scan` on 16+) over a long, representative window, and look for duplicates or prefixes of other indexes. Before dropping: check stats were not recently reset, check replicas (they have their own counters), keep unique/PK indexes because they enforce correctness, and think about rare jobs like monthly reports. Then `DROP INDEX CONCURRENTLY`.

## Sources

Plans, sizes and timings quoted above come from a local PostgreSQL 16.15 run on the seeded capstone schema; facts are checked against the PostgreSQL 18 manual (current).

- PostgreSQL: [Database Page Layout](https://www.postgresql.org/docs/current/storage-page-layout.html)
- PostgreSQL: [B-Tree Indexes (implementation)](https://www.postgresql.org/docs/current/btree.html)
- PostgreSQL: [Index Types](https://www.postgresql.org/docs/current/indexes-types.html)
- PostgreSQL: [Multicolumn Indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html)
- PostgreSQL: [Combining Multiple Indexes (bitmap scans)](https://www.postgresql.org/docs/current/indexes-bitmap-scans.html)
- PostgreSQL: [Partial Indexes](https://www.postgresql.org/docs/current/indexes-partial.html)
- PostgreSQL: [Index-Only Scans and Covering Indexes](https://www.postgresql.org/docs/current/indexes-index-only-scans.html)
- PostgreSQL: [JSON Types (jsonb indexing)](https://www.postgresql.org/docs/current/datatype-json.html)
- PostgreSQL: [Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- PostgreSQL: [EXPLAIN command](https://www.postgresql.org/docs/current/sql-explain.html)
- PostgreSQL: [Statistics Used by the Planner](https://www.postgresql.org/docs/current/planner-stats.html)
- PostgreSQL: [Heap-Only Tuples (HOT)](https://www.postgresql.org/docs/current/storage-hot.html)
- PostgreSQL: [Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- PostgreSQL: [The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html)
- PostgreSQL: [CREATE INDEX (building indexes concurrently)](https://www.postgresql.org/docs/current/sql-createindex.html)
- PostgreSQL: [REINDEX](https://www.postgresql.org/docs/current/sql-reindex.html)
- Use The Index, Luke: [Slow Indexes, Part I](https://use-the-index-luke.com/sql/anatomy/slow-indexes)
- Use The Index, Luke: [Greater, Less and BETWEEN](https://use-the-index-luke.com/sql/where-clause/searching-for-ranges/greater-less-between-tuning-sql-access-filter-predicates)
- Use The Index, Luke, ch. 7 Partial Results: [Paging Through Results](https://use-the-index-luke.com/sql/partial-results/fetch-next-page)
- SQLAlchemy 2.0: [PostgreSQL dialect (index options)](https://docs.sqlalchemy.org/en/20/dialects/postgresql.html)
- Alembic: [Runtime objects (autocommit\_block)](https://alembic.sqlalchemy.org/en/latest/api/runtime.html)
- Alembic: [Operation reference (create\_index, drop\_index)](https://alembic.sqlalchemy.org/en/latest/ops.html)
- [explain.dalibo.com](https://explain.dalibo.com/) plan visualizer
