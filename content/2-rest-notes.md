# Study Notes — Week 2: REST API Design

Oct 23, 2026 · @Mathew Matholomew

After this week you should be able to look at any endpoint and say what resource it names, what the method promises, which status code it owes the client and how its errors, pages and concurrent writes behave. You will apply that to the capstone: a versioned `/v1` FastAPI surface for events and bookings with Problem Details errors, cursor pagination, ETag-based optimistic locking and an OpenAPI schema that documents every failure. Idempotency keys are designed here and built in the Redis week.

## 1. Resource-oriented design

A REST API is a set of nouns that the client manipulates with a small, fixed set of verbs. The URL names *what* you act on; the HTTP method says *what you do* to it. Once you hold that line, most design arguments settle themselves.

### Resources, not actions

In RPC style you write `POST /createBooking` or `POST /getEventsByCity`. Every new operation adds a new endpoint and a new contract the client must learn. In resource style you expose `bookings` and `events` as collections and let the method carry the intent. `POST /events/42/bookings` creates a booking. `GET /events?city=Astana` filters a collection. The client already knows what `GET`, `POST` and `DELETE` mean, so the API has less to explain.

Google's [AIP-121](https://google.aip.dev/121) frames this as a hierarchy of resources and collections, operated on by five standard methods: Get, List, Create, Update, Delete. It adds a useful warning: the resource model is not your database schema. A `Booking` resource might join three tables; a `bookings` table might have internal columns you never expose. The [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/) say the same thing as rules: keep URLs verb-free (rule 141), pluralize resource names (rule 134), use kebab-case path segments (rule 129) and snake\_case query parameters (rule 130).

Conventions that follow from this:

- Collections are plural nouns: `/events`, `/bookings`, `/users`.
- An item is the collection plus an id: `/events/42`.
- Every prefix of a valid path is itself valid. If `/users/7/bookings` exists, so do `/users/7` and `/users`.
- IDs are opaque to clients. Use UUIDs for bookings if you don't want competitors to count your sales from sequential ids.

### Nesting: path vs query parameter

Nesting expresses ownership. `/events/42/bookings` reads as "the bookings that belong to event 42". It is a good fit when the child cannot exist without the parent and the parent id is needed to create it. That is exactly the case for creating a booking: you always book *for* an event.

But a booking also has its own identity. Once created, a client cancels it, fetches it, or lists it by user. Forcing every access through `/events/42/bookings/9f1c...` means the client must remember the event id forever. So the common pattern is: **create under the parent, address the item at the top level**.

| Need | Shape | Why |
| --- | --- | --- |
| Create a booking for an event | `POST /events/{id}/bookings` | Parent is required context |
| Fetch or cancel one booking | `GET /bookings/{id}` | Booking id is globally unique |
| A user's bookings | `GET /users/{user_id}/bookings` | Natural ownership, often authorization scope |
| Bookings filtered by several fields | `GET /bookings?event_id=42&status=confirmed` | Filters combine; paths don't |

Rule of thumb: nest one level, rarely two. Zalando's rule 147 caps it at three. Deep paths like `/cities/1/venues/3/events/42/bookings` couple the client to your whole hierarchy and break when a venue moves cities. If the relationship is just one of several ways to slice a collection, it is a filter, so make it a query parameter.

### Sub-resources vs query parameters

A path segment identifies a *thing*. A query parameter narrows, sorts or shapes a *view* of a collection. `/events/42/bookings` is a thing (that event's booking collection). `?city=Astana&sort=starts_at` is a view. If removing the parameter still leaves a meaningful resource, it belongs in the query string.

### Custom actions and when they are justified

Some operations are not CRUD on a noun. Cancelling a booking is the classic case. Three designs are available:

1. `DELETE /bookings/{id}`: treats cancel as removal. Simple, idempotent by definition. But you lose the record, or you pretend to delete while keeping it, and you can't send a cancellation reason in a body (DELETE bodies have no defined meaning).
2. `PATCH /bookings/{id}` with `{"status": "cancelled"}`: models it as a state change. Works, but lets clients send any status, so you need rules for which transitions are legal, and refund side effects hide behind a generic update.
3. `POST /bookings/{id}/cancel`: a custom method. AIP-121 allows these, written as `POST` with the verb in the path, while stating a preference for standard methods. Zalando rule 138 pushes the other way: model the action as a resource, such as `POST /bookings/{id}/cancellations`.

A custom action is justified when the operation has side effects beyond setting a field (releasing seats, refunding, emitting a `booking.cancelled` event), when it carries its own input (a reason), and when the resource must remain readable afterwards. All three are true for cancellation. Section 10 picks a design for the capstone and justifies it.

```http
POST /v1/bookings/5b0e.../cancel HTTP/1.1
Content-Type: application/json

{"reason": "schedule_conflict"}

HTTP/1.1 200 OK
Content-Type: application/json

{"id": "5b0e...", "status": "cancelled", "event_id": 42, "seats": 2}
```

### Pitfalls

- Mirroring tables: `/booking_seat_rows` leaks storage into the contract.
- Verbs creeping in: `/events/search`, `/getUserBookings`. Use filters on the collection.
- Deep nesting that forces clients to carry parent ids they don't care about.
- Singular and plural mixed (`/event/42` next to `/bookings`).
- Using a custom action for something that is honestly just a field update, such as renaming an event.

## 2. HTTP methods and their promises

A method is a promise to every intermediary between client and server: browsers, proxies, retry libraries, load balancers. They act on that promise without understanding your API. RFC 9110 defines two properties that matter most.

**Safe** (RFC 9110 §9.2.1): the client does not request any state change. `GET`, `HEAD`, `OPTIONS`, `TRACE` are safe. Crawlers, prefetchers and caches will call safe methods freely. If `GET /bookings/5/cancel` cancels a booking, a link preview in a chat app can cancel it. The server may still log or count requests; "safe" is about what the client *asked for*, not about zero side effects.

**Idempotent** (RFC 9110 §9.2.2): sending the request N times has the same *intended effect on server state* as sending it once. All safe methods, plus `PUT` and `DELETE`, are idempotent. This is the property that makes automatic retry possible. If a connection drops after you sent `PUT /events/42` and you don't know whether it arrived, you can just send it again.

The subtle point: idempotency is about server state, not identical responses. The first `DELETE /bookings/5` returns `204`; the second returns `404`. The responses differ, but the end state is the same (booking 5 is gone), so `DELETE` is still idempotent. Conversely, `POST /events/42/bookings` sent twice creates two bookings, which is why POST needs extra machinery for safe retries (section 8).

| Method | Safe | Idempotent | Typical use in the capstone | Typical success |
| --- | --- | --- | --- | --- |
| GET | yes | yes | Read an event, list events | 200, 304 |
| POST | no | no | Create a booking; custom action `cancel` | 201, 200, 202 |
| PUT | no | yes | Replace a whole resource at a known URL | 200, 204, 201 if created |
| PATCH | no | not by default | Partial update of an event | 200 |
| DELETE | no | yes | Remove a resource | 204 |

### PUT vs PATCH

`PUT` (RFC 9110 §9.3.4) sends the *complete* new representation. Fields you omit are reset to defaults or cleared. That makes it idempotent: the same body always produces the same state. It is also why PUT is awkward for clients that only know some fields; they must `GET` first and send everything back.

`PATCH` is defined separately, in RFC 5789. It sends a *description of changes*, and the format of that description is set by the media type. Two standard formats exist:

- **JSON Merge Patch** (RFC 7396, `application/merge-patch+json`). The body looks like a partial resource. Present keys overwrite, `null` deletes, absent keys are untouched. Arrays are replaced whole. Simple and readable, but you cannot set a field to an explicit `null` and cannot edit one array element.
- **JSON Patch** (RFC 6902, `application/json-patch+json`). The body is a list of operations (`add`, `remove`, `replace`, `move`, `copy`, `test`) addressed by JSON Pointer. Precise, can target array elements, and the `test` op gives you an atomic check. More verbose and harder to validate with a Pydantic model.

```http
PATCH /v1/events/42 HTTP/1.1
Content-Type: application/merge-patch+json

{"title": "PyCon KZ 2026", "description": null}
```

```http
PATCH /v1/events/42 HTTP/1.1
Content-Type: application/json-patch+json

[
  {"op": "test", "path": "/capacity", "value": 300},
  {"op": "replace", "path": "/capacity", "value": 350}
]
```

Most JSON APIs, including the capstone, use merge-patch semantics with a plain `application/json` body. In FastAPI the trick is distinguishing "absent" from "explicitly null". Pydantic v2 tracks which fields the client actually sent, and `model_dump(exclude_unset=True)` returns only those:

```python
from pydantic import BaseModel, ConfigDict, Field

class EventPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")  # reject unknown keys with 422

    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    capacity: int | None = Field(default=None, gt=0)

patch = EventPatch.model_validate({"title": "PyCon KZ", "description": None})
print(patch.model_dump(exclude_unset=True))
# {'title': 'PyCon KZ', 'description': None}  -> capacity untouched, description cleared
```

Is PATCH idempotent? It depends on the patch. `{"title": "X"}` is: applying it twice leaves the same title. A JSON Patch `add` to the end of an array is not. A design like `{"capacity_delta": +10}` is not. So keep patch bodies declarative ("set to X"), not relative ("add X"), and you get retry safety for free.

### Pitfalls

- Unsafe `GET` (side effects on read). Caches and prefetchers will trigger them.
- Treating `PUT` as partial update. Clients that omit a field will silently wipe it.
- `PATCH` with relative operations (`increment`) that break on retry.
- Assuming identical responses are required for idempotency. They are not; the state is what counts.
- Sending a body with `GET` or `DELETE`. Its meaning is undefined and many proxies drop it.

## 3. Status codes that mean something

A status code is the one part of the response every client reads before the body. Retry logic, monitoring dashboards and generated SDKs branch on it. If you return `200` with `{"error": "sold out"}`, every one of those tools thinks the booking worked. The goal is a small, consistent vocabulary where each code tells the client *what to do next*.

### Success codes

- **200 OK**: the response body is the result. Use for `GET`, for `PATCH` that returns the updated resource, and for custom actions like `cancel`.
- **201 Created** (RFC 9110 §15.3.2): a new resource exists. Add a `Location` header with its URL and usually return its representation. The client can follow `Location` without parsing the body.
- **202 Accepted** (§15.3.3): the request was queued, not completed. Return a link to a status resource. Right for long jobs; wrong for a booking you actually confirmed synchronously.
- **204 No Content** (§15.3.5): success, no body. Typical for `DELETE`. A 204 must not carry a body, and FastAPI will complain if you declare a response model on it.
- **304 Not Modified** (§15.4.5): a conditional `GET` matched the client's cached copy. Covered in section 6.

### Client error codes

- **400 Bad Request**: the request is malformed at a level below your schema: broken JSON, an unparseable cursor, a header in the wrong format.
- **422 Unprocessable Content** (§15.5.21): the syntax is fine but the content fails validation, such as `seats: -1` or a missing required field. FastAPI returns 422 for Pydantic failures by default, and many teams keep that split: 400 for "I can't parse this", 422 for "I parsed it and it's invalid".
- **401 Unauthorized** (§15.5.2): the client is *not authenticated*. Missing or expired token. The server must send a `WWW-Authenticate` header naming the scheme. The name is historical; it means unauthenticated.
- **403 Forbidden** (§15.5.4): authenticated, but not allowed. User 7 asking for `/users/8/bookings`.
- **404 Not Found**: no such resource, *or* you don't want to reveal it exists. Returning 404 instead of 403 for other users' bookings avoids leaking which ids are real.
- **409 Conflict** (§15.5.10): the request is valid but clashes with the current state of the resource. Sold out. Duplicate booking for the same user and event. Cancelling an already-refunded booking. The client can resolve it only by changing something.
- **412 Precondition Failed** (§15.5.13): a conditional header such as `If-Match` evaluated to false. Someone else changed the resource.
- **428 Precondition Required** (RFC 6585 §3): you require a conditional request and the client didn't send one. Forces clients to opt into optimistic locking.
- **429 Too Many Requests** (RFC 6585 §4): rate limited. Add `Retry-After`.

Server errors (`500`, `502`, `503`, `504`) mean the client did nothing wrong. A `503` with `Retry-After` tells it when to come back.

### Decision table

Work top to bottom and stop at the first match.

| Question | If yes |
| --- | --- |
| Could you not parse the request at all (JSON, cursor, header syntax)? | 400 |
| Is there no valid credential? | 401 + `WWW-Authenticate` |
| Is the caller authenticated but not allowed (and it's fine to reveal the resource exists)? | 403 |
| Does the target resource not exist, or must it stay hidden? | 404 |
| Is a required `If-Match` missing? | 428 |
| Did `If-Match` / `If-None-Match` fail? | 412 (or 304 for a GET with `If-None-Match`) |
| Does the body fail schema or field validation? | 422 |
| Is it valid but in conflict with current state (sold out, duplicate, wrong state)? | 409 |
| Is the caller over its rate limit? | 429 + `Retry-After` |
| Created a resource? | 201 + `Location` |
| Accepted for later processing? | 202 + status link |
| Succeeded with nothing to return? | 204 |
| Otherwise succeeded | 200 |

The 422-vs-409 line is the one people blur. Ask: *would this request succeed against a different state of the database?* If yes (seats would be available tomorrow), it's 409. If no (`seats: 0` is never valid), it's 422.

```python
from fastapi import APIRouter, Request, Response, status

router = APIRouter(prefix="/events", tags=["events"])

@router.post("/{event_id}/bookings", status_code=status.HTTP_201_CREATED,
             response_model=BookingOut)
async def create_booking(event_id: int, body: BookingCreate,
                         request: Request, response: Response) -> BookingOut:
    booking = await bookings_service.create(event_id, body)  # raises SoldOut -> 409
    response.headers["Location"] = str(
        request.url_for("get_booking", booking_id=booking.id)
    )
    return booking
```

`request.url_for` takes the *function name* of the target route, so name your handlers deliberately.

### Pitfalls

- `200` with an error body. Breaks every generic client.
- `201` without `Location`.
- `401` when you mean `403`, or vice versa.
- `500` for a predictable business rule (sold out). That pages your on-call for a customer problem.
- `404` for an empty collection. `GET /events?city=Atyrau` with no matches is `200` with `items: []`.
- Inventing codes (`499`, `460`) or using `418` outside jokes.

## 4. Errors as Problem Details (RFC 9457)

Without a standard, every API invents its own error shape, and every client writes a custom parser for it. [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) (July 2023, replacing RFC 7807) defines one JSON object for errors with the media type `application/problem+json`. Zalando makes it a MUST (rule 176). Spring, ASP.NET Core and many gateways emit it natively.

### The members

| Member | Meaning | Capstone example |
| --- | --- | --- |
| `type` | URI that identifies the *kind* of problem. Clients branch on this. Defaults to `about:blank`. | `https://api.example.kz/problems/sold-out` |
| `title` | Short human summary of the type. Same for every occurrence. | `Event is sold out` |
| `status` | The HTTP status code, repeated for convenience. Advisory only; the real status line wins. | `409` |
| `detail` | Human explanation of *this* occurrence, aimed at fixing it. | `Only 3 seats left, you asked for 4` |
| `instance` | URI for this specific occurrence. Often the request path or an error id you can find in logs. | `/v1/events/42/bookings` |

The key design idea is that `type` is the machine-readable identifier and `detail` is for humans. The RFC says `detail` should help the client "rather than giving debugging information": no stack traces, SQL or internal hostnames. Clients must never parse `detail` to make decisions. If they need data (how many seats remain), put it in an **extension member**, a top-level field your problem type defines. Clients must ignore extensions they don't recognize, so you can add them later without breaking anyone.

`about:blank` means "no extra meaning beyond the status code". Use it for generic 404s or 405s where a dedicated type adds nothing; its `title` should then be the standard reason phrase. For each business error clients must handle, define a real type URI and ideally serve a short doc page at it.

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{
  "type": "https://api.example.kz/problems/sold-out",
  "title": "Event is sold out",
  "status": 409,
  "detail": "Only 3 seats left, you asked for 4",
  "instance": "/v1/events/42/bookings",
  "seats_left": 3
}
```

Validation errors list several problems at once. RFC 9457 has no standard `errors` member; its own example defines one as an extension. A common shape uses JSON Pointers into the request so a frontend can highlight fields:

```json
{
  "type": "https://api.example.kz/problems/validation",
  "title": "Request validation failed",
  "status": 422,
  "detail": "1 field(s) failed validation",
  "instance": "/v1/events",
  "errors": [
    {"pointer": "/query/limit", "message": "Input should be less than or equal to 100", "code": "less_than_equal"}
  ]
}
```

### Implementing it in FastAPI

FastAPI's defaults return `{"detail": ...}` with `application/json`. You replace three handlers so that *every* error path produces Problem Details:

1. Your own domain exceptions (`SoldOut`, `EventNotFound`).
2. `starlette.exceptions.HTTPException`. Register on Starlette's class, not FastAPI's, so 404s for unknown routes and 405s from the router are also converted. FastAPI's `HTTPException` subclasses it, so your own `raise HTTPException(...)` is covered too.
3. `fastapi.exceptions.RequestValidationError`, raised when Pydantic rejects path, query, header or body input.

The pattern is: domain code raises domain exceptions that know nothing about HTTP; one module translates them.

```python
# app/api/errors.py
from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from starlette.exceptions import HTTPException as StarletteHTTPException

PROBLEM_BASE = "https://api.example.kz/problems/"


class Problem(BaseModel):
    """Schema for OpenAPI docs and for building responses."""
    model_config = ConfigDict(extra="allow")  # extension members
    type: str = "about:blank"
    title: str
    status: int
    detail: str | None = None
    instance: str | None = None


class ApiError(Exception):
    status: int = 500
    slug: str = "internal"
    title: str = "Internal error"

    def __init__(self, detail: str | None = None, **extensions: Any) -> None:
        self.detail = detail
        self.extensions = extensions


class EventNotFound(ApiError):
    status, slug, title = 404, "event-not-found", "Event not found"

class SoldOut(ApiError):
    status, slug, title = 409, "sold-out", "Event is sold out"


def _problem(request: Request, status: int, title: str, type_: str = "about:blank",
             detail: str | None = None, headers: dict[str, str] | None = None,
             **ext: Any) -> JSONResponse:
    body = Problem(type=type_, title=title, status=status, detail=detail,
                   instance=request.url.path, **ext)
    return JSONResponse(body.model_dump(exclude_none=True), status_code=status,
                        media_type="application/problem+json", headers=headers)


def install_problem_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def on_api_error(request: Request, exc: ApiError) -> JSONResponse:
        return _problem(request, exc.status, exc.title, PROBLEM_BASE + exc.slug,
                        exc.detail, **exc.extensions)

    @app.exception_handler(StarletteHTTPException)
    async def on_http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return _problem(request, exc.status_code, HTTPStatus(exc.status_code).phrase,
                        detail=exc.detail if isinstance(exc.detail, str) else None,
                        headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def on_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {"pointer": "/" + "/".join(str(p) for p in e["loc"]),
             "message": e["msg"], "code": e["type"]}
            for e in exc.errors()
        ]
        return _problem(request, 422, "Request validation failed",
                        PROBLEM_BASE + "validation",
                        detail=f"{len(errors)} field(s) failed validation", errors=errors)
```

Things worth noticing:

- `exc.errors()` returns dicts with `loc`, `msg`, `type` (and `input`, `ctx`). Pick fields explicitly. FastAPI's docs warn that stringifying the whole exception can leak file and line information, and echoing `exc.body` back can reflect secrets.
- `loc` starts with the source (`body`, `query`, `path`, `header`), which conveniently becomes the first pointer segment.
- Pass `exc.headers` through, so a `401` keeps its `WWW-Authenticate` and a `429` keeps `Retry-After`.
- Unhandled exceptions still become a bare `500`. Add a catch-all `Exception` handler that logs the traceback with a request id and returns a generic problem carrying only that id.

### Pitfalls

- Mixing shapes: Problem Details from your handlers, `{"detail": ...}` from FastAPI's defaults. Override all three.
- Forgetting the media type. Clients that switch on `Content-Type` miss your errors.
- Clients matching on `title` or `detail` strings. Only `type` (and extensions) are stable.
- Leaking internals in `detail`: SQL errors, constraint names, file paths.
- A `status` member that disagrees with the real status line.

## 5. Pagination, filtering and sorting

Every list endpoint must be paginated from day one. [AIP-158](https://google.aip.dev/158) points out that adding pagination later is a breaking change: clients that assumed they got everything will silently miss data. The real question is *how* you paginate.

### Offset pagination and why it degrades

`?limit=20&offset=4000` translates to `ORDER BY ... LIMIT 20 OFFSET 4000`. It looks cheap, but the database cannot jump to row 4000. It must produce rows 1 to 4020 in order and throw away the first 4000. Page 200 costs roughly 200 times page 1. [Use The Index, Luke, chapter 7 "Partial Results"](https://use-the-index-luke.com/sql/partial-results/fetch-next-page) walks through the execution plans that show this.

The second problem is correctness. Offsets count positions, and positions shift when the data changes:

- A new event is inserted on page 1 while the user reads it. Everything shifts down one place. The last item of page 1 appears again as the first item of page 2: a **duplicate**.
- An event on page 1 is deleted. Everything shifts up. The first item that would have been on page 2 moves to page 1, which the user already read: a **skip**.

For a booking site where new events are added constantly, both happen in normal use.

### Keyset (cursor) pagination

Instead of "skip N rows", say "give me rows that sort after the last one I saw". This is called the seek method or keyset pagination. If the list is sorted by `(starts_at, id)` and the last row on page 1 was `(2026-11-04 19:00, 42)`, page 2 is:

```sql
SELECT * FROM events
WHERE city = 'Astana'
  AND (starts_at, id) > ('2026-11-04 19:00+00', 42)
ORDER BY starts_at, id
LIMIT 21;   -- page size + 1, to know whether there is a next page
```

With an index on `(city, starts_at, id)`, PostgreSQL seeks straight to that position and reads 21 rows. Page 1000 costs the same as page 1. Inserts before the cursor don't shift anything, because the cursor is a *value*, not a position.

Two requirements make this work:

1. **A deterministic, unique sort order.** `starts_at` alone has ties (two concerts at 19:00). Without the `id` tiebreaker, rows with equal timestamps can be skipped or repeated across pages. Always append the primary key.
2. **Row-value comparison.** `(a, b) > (x, y)` means "a > x, or a = x and b > y". PostgreSQL supports this natively and can use a composite index for it. Some databases don't, and you have to spell out the OR form.

|  | Offset | Keyset / cursor |
| --- | --- | --- |
| Cost of deep pages | Grows with offset | Constant with a matching index |
| Correct under inserts and deletes | No (skips, duplicates) | Yes |
| Jump to page 37 | Yes | No |
| Total count | Easy but expensive (`COUNT(*)`) | Not built in |
| Sort by arbitrary column | Easy | Needs an index per sort key, plus tiebreaker |
| Good for | Small admin tables, "page 3 of 7" UIs | Feeds, infinite scroll, APIs, large tables |

Zalando rule 160 prefers cursor pagination for these reasons.

### Opaque cursors

Don't make clients send `?after_starts_at=...&after_id=...`. That freezes your sort implementation into the public contract. Encode the position into one **opaque** token and document only that it must be passed back unchanged. AIP-158 requires page tokens to be URL-safe and opaque, and notes that base64 alone is not real obfuscation. If clients tampering with cursors would matter, sign them with an HMAC. Either way, validate them and answer 400 when decoding fails.

```python
import base64
import binascii
import json
from datetime import datetime


class InvalidCursor(ValueError):
    pass


def encode_cursor(starts_at: datetime, event_id: int) -> str:
    raw = json.dumps({"s": starts_at.isoformat(), "i": event_id},
                     separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(token: str) -> tuple[datetime, int]:
    try:
        padded = token + "=" * (-len(token) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded))
        return datetime.fromisoformat(data["s"]), int(data["i"])
    except (binascii.Error, ValueError, KeyError, TypeError) as exc:
        raise InvalidCursor(token) from exc
```

A cursor is only valid with the same filters and sort that produced it. AIP-158 says to reject a token if the other parameters change. A simple way is to include a hash of the filters in the cursor payload and compare on decode.

With SQLAlchemy 2.0 the keyset predicate uses `tuple_`:

```python
from sqlalchemy import select, tuple_

stmt = select(Event)
if city:
    stmt = stmt.where(Event.city == city)
if from_:
    stmt = stmt.where(Event.starts_at >= from_)
if after:  # (starts_at, id) decoded from the cursor
    stmt = stmt.where(tuple_(Event.starts_at, Event.id) > tuple_(*after))
stmt = stmt.order_by(Event.starts_at, Event.id).limit(limit + 1)
```

Fetching `limit + 1` rows tells you whether a next page exists without a separate count query. Return the first `limit`; if the extra row exists, build `next_cursor` from the last returned row.

### Page size limits and response shape

- Have a default page size (20) and a hard maximum (100). Declare it with `Query(ge=1, le=100)` so the schema documents it. AIP-158 suggests silently clamping oversized requests instead; either is fine if documented. Rejecting with 422 is easier to reason about in tests.
- Return a wrapper object, never a bare array. A bare array can't grow new fields like `next_cursor`.
- Signal the end with `next_cursor: null`. Don't make clients detect it from a short page; AIP-158 allows short pages even mid-collection.
- Skip `total` by default. Counting a filtered table on every request is expensive and stale by the time it renders.

```http
GET /v1/events?city=Astana&from=2026-11-01T00:00:00Z&limit=20 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "items": [ {"id": 42, "title": "PyCon KZ", "city": "Astana", "starts_at": "2026-11-04T19:00:00Z"} ],
  "next_cursor": "eyJzIjoiMjAyNi0xMS0wNFQxOTowMDowMCswMDowMCIsImkiOjQyfQ"
}
```

### Filtering and sorting conventions

- Filters are plain snake\_case query parameters named after the field: `?city=Astana&status=published`.
- Ranges use clear suffixes or names: `from` and `to` for dates, or `starts_at_gte` / `starts_at_lt`. Half-open intervals (`>= from`, `< to`) avoid double-counting at boundaries.
- `from` is a Python keyword. Use `from_: Annotated[datetime | None, Query(alias="from")] = None`.
- Sorting: one `sort` parameter with a leading minus for descending, such as `sort=-starts_at`. Allow only an explicit list of sortable fields, each backed by an index. Always add `id` as the tiebreaker internally.
- Require timezone-aware datetimes in filters, or define that naive ones mean UTC.

### Pitfalls

- Offset pagination on a growing table, then wondering why the mobile feed shows duplicates.
- Sorting by a non-unique column with no tiebreaker.
- Exposing raw cursor fields as public parameters.
- No max page size, so one client asks for `limit=100000`.
- Accepting a cursor with different filters and returning nonsense instead of 400.
- A keyset query without a matching composite index. It is correct but still scans.

## 6. Conditional requests and optimistic concurrency

HTTP has a built-in way to say "only do this if the resource is still what I think it is". The server labels each version of a resource with an **ETag**, and the client sends that label back in a conditional header. The same mechanism gives you cheap caching for reads and safe concurrent writes.

### ETags

An ETag (RFC 9110 §8.8.3) is an opaque, quoted string in a response header: `ETag: "42-v7"`. It changes whenever the representation changes. A **strong** ETag promises byte-identical content. A **weak** one, written `W/"42-v7"`, only promises semantic equivalence (for example, the same data with different JSON whitespace or compression).

How you compute it is up to you:

- **From a version column.** Add `version INTEGER NOT NULL DEFAULT 1` to `events` and increment it on every update. ETag = `"{id}-v{version}"`. Cheap, no body hashing, and the same number drives the SQL check below.
- **From a hash of the body.** Works for any resource, but you must serialize the response first, and every change to serialization (a new field) changes the tag.
- **From `updated_at`.** Fragile: two updates in the same millisecond collide.

Use the version column for the capstone.

### Reads: If-None-Match and 304

A client that has event 42 cached sends `If-None-Match: "42-v7"`. If the current ETag still matches, the server answers `304 Not Modified` with no body (RFC 9110 §13.1.2). The client reuses its copy. You save serialization and bandwidth, and a mobile client saves battery. If-None-Match uses weak comparison, so `W/` tags still match.

```http
GET /v1/events/42 HTTP/1.1
If-None-Match: "42-v7"

HTTP/1.1 304 Not Modified
ETag: "42-v7"
```

### Writes: If-Match and the lost update

The lost update problem: two organizers open event 42 at version 7. Alice changes the title and saves. Bob, still looking at version 7, changes the capacity and saves. With a plain `PATCH`, Bob's request may also send the old title and silently undo Alice's change. Even with partial updates, Bob decided on a capacity based on data that is now stale.

The fix is **optimistic locking**. Each client sends `If-Match` with the ETag it read (RFC 9110 §13.1.1). The server applies the change only if the current ETag still matches, using strong comparison. Otherwise it answers `412 Precondition Failed`, and the client must re-read, merge and retry. To stop clients skipping the header, answer `428 Precondition Required` when it's missing. "Optimistic" means you take no lock while the user edits; you only detect conflicts at write time. That suits web APIs, where an edit may take minutes and holding a database lock that long is impossible.

&#91;embedded content: optimistic locking with If-Match · two editors, one conflict\]

Both editors read version 7. Alice writes first and moves the row to version 8, so Bob's stale precondition fails and he must re-read before his change can land.

The check must be atomic. Reading the row, comparing versions in Python, then updating leaves a race window between the read and the write. Put the comparison in the `UPDATE` itself:

```sql
UPDATE events
SET title = :title, version = version + 1
WHERE id = :id AND version = :expected_version
RETURNING *;
```

Zero rows updated means one of two things: the event doesn't exist (404) or the version moved on (412). A follow-up `SELECT` tells them apart.

```python
from typing import Annotated
from fastapi import Header, HTTPException, Response


def parse_version(if_match: str, event_id: int) -> int:
    # ETag format: "42-v7". Weak tags never match for If-Match.
    tag = if_match.strip()
    prefix = f'"{event_id}-v'
    if tag.startswith("W/") or not (tag.startswith(prefix) and tag.endswith('"')):
        raise VersionMismatch("ETag does not belong to this event version")
    return int(tag[len(prefix):-1])


@router.patch("/{event_id}", response_model=EventOut,
              responses={404: {"model": Problem}, 412: {"model": Problem},
                         428: {"model": Problem}})
async def patch_event(event_id: int, patch: EventPatch, response: Response,
                      service: EventServiceDep,  # Annotated[EventService, Depends(...)]
                      if_match: Annotated[str | None, Header()] = None) -> EventOut:
    if if_match is None:
        raise HTTPException(428, "Send If-Match with the ETag from your last GET")
    expected = parse_version(if_match, event_id)
    event = await service.update(event_id, patch, expected_version=expected)
    response.headers["ETag"] = f'"{event.id}-v{event.version}"'
    return event
```

FastAPI converts the `if_match` parameter name to the `If-Match` header automatically. The service raises `EventNotFound` or `VersionMismatch`, and the Problem Details handler from section 4 turns them into 404 and 412. A 412 problem can carry the current ETag as an extension so the client knows what to re-fetch.

The same idea protects booking counts. `UPDATE events SET seats_left = seats_left - :n WHERE id = :id AND seats_left >= :n` is a conditional write at the SQL level. It is what prevents overselling, independent of HTTP headers.

### Pitfalls

- Comparing versions in Python after a `SELECT`, then writing. Race window.
- Forgetting to return the new `ETag` after a successful write, so the client's next edit always fails.
- Using weak ETags for `If-Match`. Strong comparison never matches them.
- Making `If-Match` optional and never enforcing it. Without 428, nobody sends it.
- Computing ETags from `updated_at` with second precision.

## 7. Versioning and evolution

The best versioning strategy is needing it rarely. Most API changes can be made without a new version if you follow a few compatibility rules. A version bump is for the rare change you cannot make compatibly, and it costs you running two APIs side by side.

### Where the version lives

| Approach | Example | Pros | Cons |
| --- | --- | --- | --- |
| URL path | `/v1/events` | Visible in logs, curl, browser; trivial routing; easy to cache | Version in every URL; a "new version" of one resource bumps the whole API |
| Media type | `Accept: application/vnd.events.v2+json` | Versions representations, not URLs; per-resource | Invisible in logs; harder to test by hand; needs content negotiation |
| Custom header | `Api-Version: 2026-10-01` | Clean URLs; date-based versions show how old a client is | Easy to forget; proxies and caches must `Vary` on it |
| Query param | `?version=2` | Easy to try | Mixes with filters; caching surprises |

Communities disagree. Zalando forbids URL versioning (rule 115) and requires media-type versioning when you must version at all (rule 114). Google APIs put the major version in the path (`/v1/`). Stripe pins each account to a dated version sent in a header. For the capstone, use a `/v1` path prefix: it is simple, explicit, and FastAPI supports it directly with `include_router(router, prefix="/v1")`.

### What counts as backward compatible

A change is compatible if every existing client keeps working without modification.

Usually **safe**:

- Adding an optional request field with a sensible default.
- Adding a response field.
- Adding a new endpoint or a new optional query parameter.
- Adding a new problem `type` for a new failure that old clients never triggered.
- Relaxing a validation rule, such as raising max page size.

Usually **breaking**:

- Removing or renaming a field, or changing its type (`id` from int to UUID).
- Making an optional request field required.
- Tightening validation (max title length 200 to 100).
- Changing the meaning of a status code or of an existing enum value.
- Changing default sort order or pagination behavior.

The grey zone is **adding an enum value**. If a client does `match status: case "confirmed" | "cancelled"` with no default branch, a new `"refunded"` value crashes it. That's why the other half of compatibility lives in the client.

### Tolerant readers

The robustness principle for APIs: be strict in what you send and tolerant in what you accept from others. Clients should ignore unknown fields, handle unknown enum values with a fallback, and never depend on field order. On the server, the Pydantic default `extra="ignore"` makes your *response parsing* tolerant if you ever consume another service. For *request* models, `extra="forbid"` is often better: it turns a client's typo (`capcity`) into a 422 rather than a silently ignored field. Choose deliberately, and document it.

### Deprecation and sunset

When something must go away, tell clients in the protocol itself, not only in a changelog:

- **`Deprecation`** (RFC 9745, March 2025) says the resource is or will be deprecated. Its value is a structured-field date: `@` followed by Unix seconds. Deprecation changes nothing about behavior; the endpoint still works.
- **`Sunset`** (RFC 8594) gives the HTTP date after which it may stop responding. It must not be earlier than the deprecation date.
- A **`Link`** header with `rel="deprecation"` points to human-readable migration docs. `rel="successor-version"` can point to the replacement.

```http
HTTP/1.1 200 OK
Deprecation: @1798761600
Sunset: Fri, 01 Jan 2027 00:00:00 GMT
Link: <https://api.example.kz/docs/migrate-v2>; rel="deprecation"
```

(`1798761600` is 2027-01-01T00:00:00Z; here deprecation and sunset coincide for brevity. Normally the sunset comes months later.) Zalando rules 189 and 190 add the operational half: send these headers, and monitor which clients still call deprecated endpoints so you know whom to chase before the sunset date. In FastAPI, a small dependency on the deprecated router can set the headers; `deprecated=True` on a route marks it in OpenAPI.

### Pitfalls

- Bumping to `/v2` for an additive change.
- Removing a field "nobody uses" without data to prove it.
- Returning new enum values to clients that were told the set was closed.
- Deprecating only in docs, with no header and no usage monitoring.
- Running v1 and v2 as copy-pasted code. Share the service layer; version only the schemas and routers.

## 8. Idempotency keys for unsafe POSTs (design only)

`POST /events/42/bookings` is not idempotent, yet clients must be able to retry it. A phone on a train sends the request, the server books two seats, and the response is lost in a tunnel. The client cannot tell "never arrived" from "succeeded, reply lost". If it retries, the user may get four seats and two charges. If it doesn't, the user may get nothing. An idempotency key resolves this by letting the server recognize a retry.

### The mechanism

1. The client generates a random key per *logical operation* (a UUIDv4 when the user taps "Book") and sends it as a header: `Idempotency-Key: "8e03978e-..."`. Every retry of that operation reuses the same key.
2. The server scopes the key to the caller (user id + key) so two users can't collide or read each other's results.
3. The server atomically claims the key, for example with Redis `SET key value NX EX 86400`. Exactly one request wins the claim.
4. The winner executes the operation, then stores the final status code and body under the key.
5. A later request with the same key gets the stored response replayed, without running the operation again.
6. A request that arrives while the first is still running gets `409 Conflict`. The client waits and retries.
7. Keys expire after a documented window, such as 24 hours.

The server also stores a **fingerprint** of the request (a hash of method, path and body). If the same key comes back with a different body, that is a client bug, not a retry, and it gets an error.

&#91;embedded content: idempotency-key flow · one claim, three outcomes for a repeat\]

Only the request that wins the atomic claim runs the booking; every later request with the same key is answered from what was saved, or told to wait, or rejected as misuse.

### Stripe's approach

[Stripe](https://docs.stripe.com/api/idempotent_requests) is the reference implementation most people copy. Its v1 API accepts `Idempotency-Key` on all `POST` requests and suggests V4 UUIDs, with keys up to 255 characters. It stores the status code and body of the first request *once the endpoint has started executing*, and replays it for retries, even if it was a `500`. Requests that fail validation or collide with a concurrent request are not stored, so they can simply be retried. Keys can be pruned after 24 hours, and a key reused with different parameters is rejected. Keys on `GET` and `DELETE` have no effect, because those methods are already idempotent.

There is also an IETF draft standardizing the header ([draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header), still a draft). It suggests these error codes:

| Situation | Status |
| --- | --- |
| Key required but missing | 400 |
| Key reused with a different payload | 422 |
| Original request with this key still in progress | 409 |

### Design decisions for the capstone

- **Which endpoints:** `POST /v1/events/{id}/bookings` (required) and `POST /v1/bookings/{id}/cancel` (optional, since cancel is naturally idempotent if you design it so).
- **Required or optional:** Required on booking creation. Return 400 Problem Details when missing.
- **Storage:** Redis, key `idem:{user_id}:{key}`, TTL 24 h. Value holds the state (`in_progress` or `done`), the fingerprint, the status code, headers you replay (`Location`), and the body.
- **Ordering with the database:** The booking insert and "mark key done" can't share a transaction across Redis and PostgreSQL. If the process dies between them, the key stays `in_progress` until its lock TTL expires. A stronger option is a unique `(user_id, idempotency_key)` column on `bookings`, which makes PostgreSQL the final guard. Decide this in the Redis week.
- **Don't cache 5xx forever.** Unlike Stripe v1, many teams release the key on a server error so the retry can actually succeed. Choose and document.

Idempotency keys are separate from business uniqueness. "One booking per user per event" is a domain rule enforced by a unique constraint and reported as 409 `duplicate-booking`. An idempotency key only says "this exact request was already handled".

### Pitfalls

- Generating a new key on each retry. Then it protects nothing.
- Check-then-set without atomicity (`GET` then `SET`). Two concurrent retries both execute.
- Keys not scoped to the user, which leaks one user's response to another.
- Ignoring the fingerprint, so a reused key silently returns a different booking.
- No expiry, so the store grows forever.

## 9. Structuring a FastAPI project for a clean API

Everything above is easy to get right in one handler and hard to keep right across thirty. Structure is how you make the right thing the default. The goal: HTTP concerns live in one layer, business rules in another, persistence in a third, so each can change without touching the others. If you have used NestJS, this will feel familiar: controllers, services, providers and DTOs map almost one-to-one.

### A layout that scales

```
app/
  main.py              # create_app(): include routers, install handlers
  core/
    config.py          # pydantic-settings
    db.py              # async engine, session dependency
  api/
    errors.py          # Problem model, ApiError, exception handlers
    deps.py            # shared dependencies: current user, pagination params
    v1/
      __init__.py      # v1 = APIRouter(); includes events, bookings, users
      events.py        # routes only: parse, call service, shape response
      bookings.py
      users.py
  schemas/             # Pydantic models: the public contract
    events.py          # EventCreate, EventPatch, EventOut, EventPage
    bookings.py
  models/              # SQLAlchemy ORM: the storage shape
    event.py
    booking.py
  services/            # business rules, no FastAPI imports
    events.py
    bookings.py
  repositories/        # SQL queries
    events.py
```

### Schemas vs models

These are two different things that happen to share field names.

- **Schemas** (Pydantic) are the API contract. They decide what clients may send and what they see. You often need several per resource: `EventCreate` (no `id`, no `version`), `EventPatch` (all optional), `EventOut` (adds `id`, `version`, computed `seats_left`).
- **Models** (SQLAlchemy) are the storage shape. They have foreign keys, internal flags, audit columns.

Keeping them separate means you can rename a column without breaking clients, and you never leak `password_hash` because someone returned an ORM object. Set `model_config = ConfigDict(from_attributes=True)` on output schemas so Pydantic v2 can read ORM attributes directly.

### The service layer

Routes should be thin: extract input, call one service method, return. The service holds the rules ("can't book a past event", "can't overbook") and raises domain exceptions like `SoldOut`. It imports nothing from FastAPI, so you can call it from a Kafka consumer or a CLI and unit-test it without HTTP. The exception handlers from section 4 translate its exceptions into status codes. That one mapping is the only place that knows `SoldOut` means 409.

### Dependency injection

FastAPI's `Depends` builds an object graph per request. A dependency can itself depend on others, and generator dependencies (`yield`) run cleanup after the response. Use `Annotated` aliases so signatures stay short:

```python
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:   # async_sessionmaker from core/db.py
        yield session                        # closed after the response

SessionDep = Annotated[AsyncSession, Depends(get_session)]


class EventRepository:
    def __init__(self, session: SessionDep) -> None:
        self.session = session


class EventService:
    def __init__(self, repo: Annotated[EventRepository, Depends()]) -> None:
        self.repo = repo


EventServiceDep = Annotated[EventService, Depends()]
```

`Depends()` with no argument uses the class itself as the dependency, and FastAPI resolves its constructor parameters recursively. All dependencies in one request share the same session, because FastAPI caches a dependency's result per request. In tests, swap any piece with `app.dependency_overrides[EventService] = lambda: FakeEventService()`.

### Response models and documented errors

`response_model` (or the return annotation) does two jobs: it filters the output to declared fields, and it generates the success schema in OpenAPI. Errors are not documented unless you declare them. Use `responses=` with the `Problem` model, and share common sets so every route documents them consistently:

```python
from fastapi import APIRouter

from app.api.errors import Problem

def problem(description: str) -> dict:
    # Attach the schema to the media type we really send.
    schema = Problem.model_json_schema()
    return {"description": description,
            "content": {"application/problem+json": {"schema": schema}}}

COMMON = {422: problem("Validation failed")}

router = APIRouter(prefix="/events", tags=["events"], responses=COMMON)


@router.get("/{event_id}", response_model=EventOut,
            responses={404: problem("Event not found")})
async def get_event(event_id: int, service: EventServiceDep) -> EventOut:
    return await service.get(event_id)
```

Three FastAPI facts to remember. First, `responses=` only *documents*; your exception handler is what actually produces that body. Second, if you pass `{"model": Problem}`, FastAPI documents it under `application/json`, the wrong media type; building the `content` entry yourself, as above, fixes that. Third, router-level `responses` merge with route-level ones, so put the codes every route can return (422, 401) on the router. Then mount the whole version at once:

```python
# app/main.py
from fastapi import FastAPI

from app.api.errors import install_problem_handlers
from app.api.v1 import router as v1_router


def create_app() -> FastAPI:
    app = FastAPI(title="Event Booking API", version="1.0.0")
    install_problem_handlers(app)
    app.include_router(v1_router, prefix="/v1")
    return app


app = create_app()
```

A factory function lets tests build a fresh app with different settings.

### Pitfalls

- Returning ORM objects with no `response_model`. Internal columns leak.
- One `Event` Pydantic model for create, update and output. `id` becomes writable, or required on create.
- Business rules in route functions. They can't be reused by the Kafka worker.
- Services raising `HTTPException`. Now your domain layer knows about HTTP.
- Error codes missing from OpenAPI, so generated clients don't model them.
- A global session object instead of a per-request dependency.

## Apply it to the capstone

This week's goal is the HTTP surface of the booking service, backed by PostgreSQL. Redis and Kafka come later, but design for them now: the booking endpoint will take an `Idempotency-Key`, and a successful booking will publish `booking.created`.

### Endpoint table

| Method and path | Purpose | Success | Main errors | Notes |
| --- | --- | --- | --- | --- |
| `GET /v1/events` | List upcoming events | 200 | 400 bad cursor, 422 bad filter | Cursor pagination; filters `city`, `from`; `limit` 1 to 100 |
| `POST /v1/events` | Create an event (organizer) | 201 + `Location`, `ETag` | 401, 403, 422 | Body `EventCreate` |
| `GET /v1/events/{event_id}` | Event detail | 200 + `ETag`, or 304 | 404 | Honors `If-None-Match` |
| `PATCH /v1/events/{event_id}` | Partial update | 200 + new `ETag` | 404, 412, 422, 428 | Requires `If-Match`; merge-patch semantics |
| `POST /v1/events/{event_id}/bookings` | Book seats | 201 + `Location` | 404, 409 `sold-out`, 409 `duplicate-booking`, 422 | Later: `Idempotency-Key`, emits `booking.created` |
| `GET /v1/bookings/{booking_id}` | Booking detail | 200 | 404 | Target of `Location` |
| `POST /v1/bookings/{booking_id}/cancel` | Cancel, release seats | 200 with cancelled booking | 404, 409 `not-cancellable` | Repeating it returns 200 again |
| `GET /v1/users/{user_id}/bookings` | A user's bookings | 200 | 403 or 404, 422 | Cursor pagination, newest first |

### Task 1: routers and schemas

Create `api/v1/events.py`, `bookings.py`, `users.py`, each an `APIRouter` with its prefix and tag, and one `api/v1/__init__.py` that includes them. Mount it with `prefix="/v1"` in `create_app()`. Write separate `EventCreate`, `EventPatch`, `EventOut`, `EventPage`, `BookingCreate`, `BookingOut` schemas. Hints:

- `EventOut` should expose `seats_left`, not internal counters. Clients need the number; they don't need your accounting.
- Use `UUID` for booking ids, and keep `int` for events if you like.
- Add `version: int` to the `events` table now. You need it for the ETag task.

### Task 2: meaningful status codes

- `POST /events` and `POST /events/{id}/bookings` return 201 and set `Location` with `request.url_for(...)`. Give your route functions stable names (`get_event`, `get_booking`) because `url_for` uses them.
- The no-oversell rule belongs in SQL, not Python. Decrement seats with a conditional update, and treat "0 rows updated" as sold out:

```python
from sqlalchemy import update

stmt = (
    update(Event)
    .where(Event.id == event_id, Event.seats_left >= seats)
    .values(seats_left=Event.seats_left - seats)
    .returning(Event.id)
)
if (await session.execute(stmt)).first() is None:
    ...  # 404 if the event doesn't exist, else raise SoldOut(seats_left=...)
```

- Duplicate booking: add a unique constraint on `(user_id, event_id)` if your rules allow one booking per user per event, catch `IntegrityError` in the repository, and raise `DuplicateBooking` (409). Don't check-then-insert in Python; two parallel requests both pass the check.
- Do the seat decrement and the booking insert in one transaction, so a failure in one rolls back the other.

### Task 3: DELETE vs POST cancel (justify in your README)

A reasonable choice is **`POST /v1/bookings/{id}/cancel`**. The arguments to write down:

- Cancel is a state transition, not removal. The booking must stay readable for history, refunds and support.
- It has side effects beyond the row: release seats, later emit `booking.cancelled` to Kafka.
- It may take input (a reason), and DELETE bodies have no defined semantics.
- It returns the updated booking (200), which is more useful to the client than a 204.

Make it idempotent by design: cancelling an already-cancelled booking returns 200 with the same body and releases no seats twice. Guard it in SQL with `WHERE status = 'confirmed'`. If you choose `DELETE` instead, the honest version is a soft delete returning 204, and you should say why you accept losing the body.

### Task 4: one Problem Details handler

Put `Problem`, `ApiError` and its subclasses, and `install_problem_handlers()` in `api/errors.py` (section 4). Minimum set of problem types: `event-not-found`, `booking-not-found`, `sold-out`, `duplicate-booking`, `not-cancellable`, `version-mismatch`, `validation`. Register handlers for `ApiError`, Starlette's `HTTPException` and `RequestValidationError`. Add a catch-all `Exception` handler that logs and returns a 500 problem. Test: an unknown route, a wrong method and a bad body should all return `application/problem+json`.

### Task 5: cursor pagination and filters on GET /events

- Signature sketch: `city: str | None = None`, `from_: Annotated[datetime | None, Query(alias="from")] = None`, `limit: Annotated[int, Query(ge=1, le=100)] = 20`, `cursor: str | None = None`.
- Sort by `(starts_at, id)`. Create the index `CREATE INDEX ix_events_city_starts_id ON events (city, starts_at, id)`, and check with `EXPLAIN ANALYZE` that page 50 is as fast as page 1.
- Fetch `limit + 1`, return `{"items": [...], "next_cursor": ...}`.
- Put the filter values (or their hash) inside the cursor and reject a cursor used with different filters (400).
- Write a test that inserts a new event between fetching page 1 and page 2 and asserts no duplicates. This is the test that offset pagination fails.

### Task 6: ETag and If-Match on PATCH

- `GET /events/{id}`: set `ETag: "{id}-v{version}"`; if `If-None-Match` matches, return `Response(status_code=304, headers={"ETag": tag})`.
- `PATCH /events/{id}`: no `If-Match` gives 428. Parse the expected version and run `UPDATE ... WHERE id = :id AND version = :v ... SET version = version + 1 RETURNING *`. Zero rows plus the event existing gives 412. Return the new ETag.
- Apply only `patch.model_dump(exclude_unset=True)`. Reject `capacity` below the number of seats already sold with 409. That is a state conflict, not a validation error.
- Test the full race from the diagram in section 6 with two `TestClient` calls.

### Task 7: /v1 and documented errors

- Use the `problem(description)` helper from section 9 so every error response in OpenAPI is `application/problem+json` with the `Problem` schema.
- Router-level: 422. Route-level: the specific codes from the table above.
- Open `/docs` and check that every endpoint lists its error codes. A generated TypeScript client should be able to model them.

### Done when

- [ ] All eight endpoints respond under `/v1` with the codes in the table
- [ ] No error path returns `{"detail": ...}`
- [ ] Two concurrent bookings for the last seat produce one 201 and one 409
- [ ] A stale `If-Match` gets 412; a missing one gets 428
- [ ] Paging through events while inserting new ones never duplicates or skips
- [ ] OpenAPI shows every documented error with the Problem schema
- [ ] README explains the cancel design and the planned idempotency-key flow

## Check yourself

Try to answer out loud, as in an interview, before reading the answers.

1. Why do we create bookings at `/events/{id}/bookings` but fetch them at `/bookings/{id}`?
2. `DELETE /bookings/5` returns 204 the first time and 404 the second. Is DELETE still idempotent? Why?
3. A client sends `PUT /events/42` with only `{"title": "New"}`. What should happen to the other fields, and why is that a problem?
4. You receive `{"seats": 4}` for an event with 3 seats left. 409 or 422? What about `{"seats": -1}`?
5. What is the difference between 401 and 403, and when would you return 404 instead of 403?
6. In RFC 9457, which member should a client branch on, and why not `detail`?
7. Why does offset pagination produce duplicates when new rows are inserted, and how does keyset pagination avoid it?
8. Your keyset query sorts by `starts_at` only. What goes wrong?
9. Why must the If-Match version check happen inside the `UPDATE` statement rather than in Python?
10. When do you return 412 and when 428?
11. Is adding a new value to the `status` enum in `BookingOut` a breaking change?
12. A mobile client retries `POST /bookings` after a timeout. Walk through what an idempotency key changes, including two retries racing each other.

## Answers

1. Creating needs the parent as context, so the nested path fits. After creation the booking has a globally unique id and its own life (cancel, fetch, list by user), so a flat path avoids forcing clients to carry the event id forever.
2. Yes. Idempotency is defined by the intended effect on server state. After one call or ten, booking 5 is gone. Different responses don't matter.
3. PUT means full replacement, so omitted fields should be reset or cleared. Clients that only know some fields will wipe data. Use PATCH for partial updates.
4. `seats: 4` with 3 left is 409: the request is valid and would succeed in a different state. `seats: -1` is 422: it is never valid regardless of state.
5. 401 means not authenticated (no or bad credentials) and must carry `WWW-Authenticate`. 403 means authenticated but not allowed. Return 404 when revealing that the resource exists would itself leak information, such as other users' booking ids.
6. `type`, a stable URI identifying the problem kind. `detail` is human text for this occurrence and may change wording or language. Machine data goes in extension members.
7. Offset counts positions. An insert before the current page shifts every later row down one, so the last row of page 1 reappears on page 2. Keyset filters by the last seen sort values, which don't move when other rows are inserted.
8. Ties. Rows with equal `starts_at` have no defined order, so a page boundary inside a tie can skip or repeat rows. Add the unique `id` as a tiebreaker in both `ORDER BY` and the cursor.
9. A separate read-compare-write leaves a race window: another request can update between your `SELECT` and your `UPDATE`. `WHERE version = :expected` makes the database do the check and the write atomically.
10. 428 when the client sent no `If-Match` but you require one. 412 when it sent one and it doesn't match the current ETag.
11. Formally additive, but it breaks clients that treat the enum as closed. Document enums as open, require tolerant readers, and announce new values before shipping them.
12. The client reuses one key for all retries. The server atomically claims the key; the first request runs and stores its response. A retry after completion gets the stored 201 replayed, with no second booking. A retry while the first is still running gets 409 and tries again later. The same key with a different body gets 422.

## Sources

Standards and guidelines

- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html) (section numbers for methods, conditional requests and status codes)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)
- [RFC 7396: JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396.html)
- [RFC 9745: The Deprecation HTTP Response Header Field](https://www.rfc-editor.org/rfc/rfc9745.html)
- [draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header) (Internet-Draft, not yet an RFC)
- [Google AIP-121: Resource-oriented design](https://google.aip.dev/121)
- [Google AIP-158: Pagination](https://google.aip.dev/158)
- [Zalando RESTful API Guidelines](https://opensource.zalando.com/restful-api-guidelines/)

Explanations and references

- [MDN: Idempotent](https://developer.mozilla.org/en-US/docs/Glossary/Idempotent)
- [MDN: If-Match](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-Match)
- [MDN: 428 Precondition Required](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/428)
- [Use The Index, Luke, ch. 7 Partial Results: Fetching the next page](https://use-the-index-luke.com/sql/partial-results/fetch-next-page)
- [Stripe API: Idempotent requests](https://docs.stripe.com/api/idempotent_requests)

FastAPI

- [Handling Errors](https://fastapi.tiangolo.com/tutorial/handling-errors/)
- [Additional Responses in OpenAPI](https://fastapi.tiangolo.com/advanced/additional-responses/)
- [Bigger Applications: Multiple Files](https://fastapi.tiangolo.com/tutorial/bigger-applications/)

RFC 5789 (PATCH), RFC 6902 (JSON Patch), RFC 6585 (428, 429) and RFC 8594 (Sunset) are referenced through the pages above. Code samples were run against FastAPI 0.161.1 and Pydantic 2.13.5.
