# Study Notes — Week 9: API Security

Oct 23, 2026 · @Mathew Matholomew

After this week you should be able to look at the event-booking API the way an attacker would, name which of the ten OWASP API risks each endpoint is exposed to, and fix them with concrete FastAPI, SQLAlchemy and Pydantic patterns. You will also wire security checks (pip-audit, bandit, secret scanning) into CI so the fixes stay fixed. Authentication mechanics (passwords, JWT, OAuth) live in the sibling doc; this one covers everything around them: authorization, input handling, browser concerns, abuse, secrets, dependencies and logging.

## 1. Thinking about API security: threat models and defense in depth

Security work starts with a map, not a tool: what you protect, where input enters, and where trust changes hands. Without that map you patch whatever a scanner reports and miss the logic flaws that scanners cannot see, such as one user cancelling another user's booking.

### Threat modelling in four questions

A lightweight threat model answers four questions. What are we building? What can go wrong? What are we doing about it? Did we do a good enough job? You do not need a formal methodology for a capstone. A one-page list, kept next to the README, is enough.

**Assets** are the things worth stealing, breaking or abusing. In the booking API they are:

- **User data**: emails, names, password hashes, refresh tokens.
- **Booking integrity**: seat counts must never go below zero; one user's bookings are theirs alone.
- **Availability**: the API must stay up during a popular event's ticket release.
- **Secrets**: the JWT signing key, the Postgres password, Kafka credentials, any webhook or email provider keys.
- **Business value**: seats themselves. A bot that books every seat and resells them is a loss even if no code is "broken".

**Entry points** are every place untrusted data reaches your code: HTTP routes (path, query, headers, body, cookies), Kafka messages consumed by the worker, responses from third-party APIs, environment variables and config files, and the Docker images and Python packages you install.

**Trust boundaries** are lines where data moves from a less trusted zone to a more trusted one. Every crossing needs a check: authentication, authorization, validation or a size limit. In the capstone the important crossings are:

1. Internet to reverse proxy (TLS termination, request size limits).
2. Proxy to FastAPI (authentication, authorization, Pydantic validation, rate limits).
3. FastAPI to Postgres (parameterized queries, a least-privilege DB role).
4. FastAPI to Kafka, and Kafka to the worker. The worker must not assume a message is well formed just because it came from "inside".
5. Worker or API to third-party services (email provider, webhook targets). Their responses are untrusted input too.

A useful habit is to walk one request across the map. `POST /bookings` crosses boundaries 1, 2, 3 and 4. At each crossing ask: who is the caller, what can they control, and what stops them from sending something hostile?

&#91;embedded content: booking system trust boundaries · 3 zones, 5 crossings\]

The FastAPI app is the main enforcement point, but each crossing has its own control: the proxy filters at 1, the app checks at 2, bound parameters and a limited DB role protect 3, schema validation guards 4 on both sides of Kafka, and URL and response validation cover 5.

### STRIDE as a prompt list

STRIDE is a checklist of threat categories you can apply to each boundary: Spoofing (pretending to be another user), Tampering (changing a booking you do not own), Repudiation (denying an action because nothing was logged), Information disclosure (leaking emails in an event's attendee list), Denial of service (a query that scans a million rows), and Elevation of privilege (a normal user calling an admin route). You do not need to fill every cell. Use it to make sure you asked the question.

### Defense in depth

Assume any single control will fail one day. Layer them so a failure in one is caught by the next:

| Layer | Control in the capstone | What it catches if the layer above fails |
| --- | --- | --- |
| Edge | Reverse proxy: TLS, body size cap, basic rate limit | Floods before they reach Python |
| Application | Auth dependency, per-object ownership check, Pydantic `extra="forbid"` | Forged IDs, mass assignment |
| Data access | Parameterized queries, `CHECK (seats_available >= 0)` constraint, row locks | Injection; overselling if app logic has a race |
| Database role | App user cannot `DROP` or `ALTER`; separate migration user | Damage limited if injection does slip through |
| Monitoring | Audit log of auth and booking events, alerts on spikes | Attacks that pass every check above |

The database `CHECK` constraint is a good example. Your service layer already prevents overselling with `SELECT ... FOR UPDATE`. The constraint costs nothing and turns a future race-condition bug into a failed transaction instead of a negative seat count.

**Pitfalls**

- Treating internal traffic as trusted. A compromised worker or a malformed Kafka message is still hostile input.
- Modelling only the happy path. The interesting threats are in the error paths: retries, partial failures, timeouts.
- Writing the threat model once and never updating it. Revisit it when you add an endpoint or an integration.
- Relying on one layer, for example "the frontend never sends that field". Attackers do not use your frontend.

## 2. The OWASP API Security Top 10 (2023)

The 2023 list is dominated by authorization and business-logic flaws, not by classic injection. Three of the ten are about authorization at different granularities (object, property, function). That is the main lesson: an API's biggest risk is usually that it does exactly what it was asked, for the wrong person.

| ID | Risk | One-line idea | Where it bites the booking API |
| --- | --- | --- | --- |
| API1 | Broken Object Level Authorization (BOLA) | Caller reaches an object by ID without an ownership check | `GET /bookings/{id}`, `DELETE /bookings/{id}` |
| API2 | Broken Authentication | Weak login, token or session handling | `/auth/login`, token refresh |
| API3 | Broken Object Property Level Authorization | Reading or writing fields the caller should not see or set | `UserOut` leaking `password_hash`; `status` set by client |
| API4 | Unrestricted Resource Consumption | No limits on size, rate, page length or cost | `GET /events?limit=100000`, email sends |
| API5 | Broken Function Level Authorization | Normal user reaches admin-only functions | `POST /events`, `/admin/*` |
| API6 | Unrestricted Access to Sensitive Business Flows | Automated abuse of a legitimate flow | Bots booking every seat at release time |
| API7 | Server Side Request Forgery (SSRF) | Server fetches a URL the attacker chose | Organizer webhook URL, avatar-by-URL |
| API8 | Security Misconfiguration | Unsafe defaults, verbose errors, loose CORS, missing headers | `debug=True`, `allow_origins=["*"]` |
| API9 | Improper Inventory Management | Forgotten versions, hosts, debug routes | Old `/v1` without the new checks, public `/docs` |
| API10 | Unsafe Consumption of APIs | Trusting third-party responses blindly | OAuth profile data, payment or email provider callbacks |

Injection is no longer a separate entry. It now sits under misconfiguration and unsafe consumption, but it is still real, so section 3 treats it on its own.

### API1: Broken Object Level Authorization

**What it is.** An endpoint takes an object ID from the client and loads that object without checking that the caller may access it. IDs are easy to guess or enumerate, so one valid token becomes access to everyone's data. This is the most common API flaw because authentication middleware gives a false sense of safety: the user is logged in, but nobody asked whether this booking is theirs.

```python
# Vulnerable: any logged-in user can read or cancel any booking
@router.get("/bookings/{booking_id}", response_model=BookingOut)
async def get_booking(booking_id: int, user: CurrentUser, db: DbSession):
    booking = await db.get(Booking, booking_id)
    if booking is None:
        raise HTTPException(404)
    return booking
```

**Fix.** Put the ownership rule in the query itself, so it cannot be forgotten in one branch. Return 404 (not 403) for objects the caller does not own, so existence is not revealed.

```python
async def get_owned_booking(db: AsyncSession, booking_id: int, user_id: int) -> Booking:
    stmt = select(Booking).where(Booking.id == booking_id, Booking.user_id == user_id)
    booking = await db.scalar(stmt)
    if booking is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Booking not found")
    return booking

@router.delete("/bookings/{booking_id}", status_code=204)
async def cancel_booking(booking_id: int, user: CurrentUser, db: DbSession):
    booking = await get_owned_booking(db, booking_id, user.id)
    await booking_service.cancel(db, booking)
```

Random UUIDs instead of sequential integers make guessing harder but are not authorization. Keep the check either way.

### API2: Broken Authentication

**What it is.** Flaws in how identity is proven: no brute-force protection on login, tokens that never expire, accepting unsigned or `alg=none` JWTs, leaking tokens in URLs or logs, or password reset flows that can be guessed. The sibling doc covers the mechanics. Here the focus is the API surface around them.

```python
# Vulnerable: unlimited guesses, and the error tells an attacker which emails exist
@router.post("/auth/login")
async def login(body: LoginIn, db: DbSession):
    user = await users.by_email(db, body.email)
    if user is None:
        raise HTTPException(404, "No such user")
    if not verify(body.password, user.password_hash):
        raise HTTPException(401, "Wrong password")
    ...
```

**Fix checklist.**

- One generic error for every login failure ("Invalid email or password").
- A strict rate limit on `/auth/login`, `/auth/refresh` and password reset, keyed by IP and by account.
- Short-lived access tokens; refresh tokens stored server-side (or in Redis) so they can be revoked.
- Pin the JWT algorithm when decoding (`algorithms=["HS256"]`) and validate `exp`, `iss`, `aud`.
- Never put tokens in query strings; they end up in proxy logs.
- Write an audit log line for every login success, failure and token refresh (section 9).

### API3: Broken Object Property Level Authorization

**What it is.** The caller may access the object, but not every field of it. Two directions: reading too much (excessive data exposure) and writing too much (mass assignment). In 2019 these were two separate risks; 2023 merged them because the fix is the same: decide per field who can read and write it.

```python
# Vulnerable read: the ORM object is returned as-is, including password_hash and is_admin
@router.get("/users/me")
async def me(user: CurrentUser):
    return user.__dict__

# Vulnerable write: every key in the body is copied onto the row
@router.patch("/bookings/{booking_id}")
async def update_booking(booking_id: int, body: dict, user: CurrentUser, db: DbSession):
    booking = await get_owned_booking(db, booking_id, user.id)
    for key, value in body.items():
        setattr(booking, key, value)   # client can set status="confirmed", price=0
    await db.commit()
```

**Fix.** Separate input and output schemas, `extra="forbid"` on inputs, and `response_model` on every route. Section 3 has the full pattern.

```python
class BookingUpdate(StrictInput):          # extra="forbid" lives on the base
    seats: Annotated[int, Field(ge=1, le=10)]

@router.patch("/bookings/{booking_id}", response_model=BookingOut)
async def update_booking(booking_id: int, body: BookingUpdate, user: CurrentUser, db: DbSession):
    booking = await get_owned_booking(db, booking_id, user.id)
    return await booking_service.change_seats(db, booking, body.seats)
```

### API4: Unrestricted Resource Consumption

**What it is.** Every request costs CPU, memory, DB time, bandwidth, and sometimes money (an email, an SMS). Without limits one client can exhaust them. It includes missing rate limits, unbounded page sizes, huge request bodies, no timeouts, and endpoints that trigger paid third-party calls.

```python
# Vulnerable: limit is unbounded; limit=10_000_000 loads the table into memory
@router.get("/events")
async def list_events(limit: int = 100, offset: int = 0, db: DbSession = ...):
    return (await db.scalars(select(Event).limit(limit).offset(offset))).all()
```

**Fix.** Cap every dimension. Section 5 covers rate limiting, body size and timeouts in detail.

```python
@router.get("/events", response_model=list[EventOut])
async def list_events(
    db: DbSession,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
):
    stmt = select(Event).order_by(Event.starts_at, Event.id).limit(limit).offset(offset)
    return (await db.scalars(stmt)).all()
```

### API5: Broken Function Level Authorization

**What it is.** API1 is about *which object*; API5 is about *which action*. A regular user calls an admin endpoint because the route only checks that someone is logged in. Admin routes are often easy to guess (`/admin/events`, or a `PUT` on a resource where only `GET` was meant for users).

```python
# Vulnerable: any authenticated user can create or delete events
@router.post("/events", response_model=EventOut)
async def create_event(body: EventCreate, user: CurrentUser, db: DbSession): ...
```

**Fix.** Make role checks a dependency and attach it at the router level, so a new admin route cannot be added without it.

```python
def require_role(*roles: Role):
    async def checker(user: CurrentUser) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Forbidden")
        return user
    return checker

admin_router = APIRouter(
    prefix="/admin",
    dependencies=[Depends(require_role(Role.ADMIN, Role.ORGANIZER))],
)
```

Deny by default: every route should declare who may call it. A test that iterates over `app.routes` and asserts each one has an auth dependency catches new routes that forgot.

### API6: Unrestricted Access to Sensitive Business Flows

**What it is.** No bug in the code, but a flow that hurts the business when automated. For your capstone this is the core one: a script books every seat the second tickets go on sale, then resells them or cancels at the last minute. OWASP's own example is seat hoarding on flights. The endpoint works perfectly; it just works for a bot.

```python
# Vulnerable: one user can book 10 seats, a thousand times, in a second
@router.post("/bookings", response_model=BookingOut, status_code=201)
async def create_booking(body: BookingCreate, user: CurrentUser, db: DbSession):
    return await booking_service.book(db, user.id, body.event_id, body.seats)
```

**Fix checklist.** Identify the sensitive flows first (booking, account sign-up, cancellation with refund). Then add business rules, not just generic rate limits:

- Per-user cap on seats per event, enforced in the DB transaction (`SUM(seats) WHERE user_id = :uid AND event_id = :eid`).
- A tighter rate limit on `POST /bookings` than on reads.
- Hold-then-confirm: a booking holds seats for a few minutes before confirmation, and unconfirmed holds expire.
- Require a verified email before booking.
- Alert on unusual patterns: one account booking for many events in seconds, many accounts from one IP.

### API7: Server Side Request Forgery

**What it is.** The API fetches a URL that the client controls. The server sits inside your network, so it can reach things the attacker cannot: the cloud metadata endpoint, Redis, internal admin panels, `localhost` services. The capstone becomes vulnerable the moment you add "organizer registers a webhook URL" or "set avatar from URL". Section 6 has the fix pattern.

```python
# Vulnerable: the worker POSTs to whatever URL the organizer saved
async def notify_webhook(event: Event, payload: dict) -> None:
    async with httpx.AsyncClient() as client:
        await client.post(event.webhook_url, json=payload)
```

### API8: Security Misconfiguration

**What it is.** The code is fine but the settings are not: debug mode on, stack traces in responses, `allow_origins=["*"]` with credentials, missing security headers, unused HTTP methods enabled, default credentials on Postgres, Kafka listening without auth on a public interface.

```python
# Vulnerable defaults that often reach production
app = FastAPI(debug=True)                      # tracebacks in HTTP responses
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
```

**Fix checklist.** `debug=False` driven by settings; explicit CORS origins (section 4); security headers middleware (section 4); a global exception handler that returns Problem Details with no internals (section 9); in `docker-compose.yml`, publish only the proxy's port and keep Postgres, Redis and Kafka on an internal network.

### API9: Improper Inventory Management

**What it is.** You cannot protect endpoints you forgot exist. Typical cases: `/v1` still deployed after `/v2` added authorization fixes, a staging host with production data, a debug route left from development, interactive docs open to the internet.

```python
# Vulnerable: a convenience route from week 3 that nobody removed
@router.get("/debug/users")
async def all_users(db: DbSession):
    return (await db.scalars(select(User))).all()
```

**Fix checklist.**

- Treat the generated OpenAPI schema as the inventory. Commit a snapshot and diff it in CI so new routes are visible in review.
- Disable or protect docs in production: `FastAPI(docs_url=None, redoc_url=None, openapi_url=None)` when `settings.env == "prod"`.
- Version deliberately (`/api/v1`), and retire old versions rather than leaving them running.
- Document every host and integration (API, worker, Kafka topics, email provider) in the README.

### API10: Unsafe Consumption of APIs

**What it is.** Developers validate user input carefully but trust data from "partner" APIs. An attacker who controls or compromises that partner, or who can influence what it returns (for example their OAuth profile name), reaches your system through the side door. Common cases: following redirects blindly, no timeout, no schema validation on responses, storing a third-party string and later rendering it or putting it in SQL.

```python
# Vulnerable: no timeout, follows redirects, trusts any JSON shape
resp = await client.get(f"{PROVIDER}/userinfo", headers=auth, follow_redirects=True)
user.display_name = resp.json()["name"]       # unbounded string from outside
```

**Fix.** Validate upstream responses with a Pydantic model exactly as you would a request body; set timeouts; do not follow redirects unless they go to an allow-listed host; use TLS. Section 6 shows the code.

## 3. Injection and input validation

Injection happens when data is glued into a command string, so the interpreter (Postgres, a shell, a template engine) cannot tell where your code ends and the attacker's data begins. The fix is structural: send code and data separately. Validation is the second layer. It rejects input that is the wrong shape before it reaches business logic at all.

### Parameterized queries in SQLAlchemy 2.0

With a parameterized query the SQL text and the values travel to Postgres separately. The driver (asyncpg or psycopg) sends the statement with placeholders, then sends the values as typed data. Postgres never parses a value as SQL, so `Astana' OR '1'='1` is just an odd city name that matches nothing.

The ORM and Core expression API parameterize for you:

```python
from sqlalchemy import select

stmt = select(Event).where(Event.city == city, Event.starts_at >= now)
events = (await db.scalars(stmt)).all()
```

When you need raw SQL (a reporting query, a `FOR UPDATE SKIP LOCKED`), use `text()` with named bind parameters:

```python
from sqlalchemy import bindparam, text

RESERVE = text("""
    UPDATE events
       SET seats_available = seats_available - :seats
     WHERE id = :event_id
       AND seats_available >= :seats
    RETURNING seats_available
""")
remaining = await db.scalar(RESERVE, {"event_id": body.event_id, "seats": body.seats})
if remaining is None:
    raise HTTPException(409, "Not enough seats")

# A list of IDs needs an expanding bind parameter, not string joining
BY_IDS = text("SELECT id, title FROM events WHERE id IN :ids").bindparams(
    bindparam("ids", expanding=True)
)
rows = (await db.execute(BY_IDS, {"ids": [1, 2, 3]})).all()
```

The conditional `UPDATE ... WHERE seats_available >= :seats` doubles as overselling protection: the check and the decrement happen in one atomic statement.

### Why f-strings in SQL are dangerous

```python
# Vulnerable: the value becomes part of the SQL text
await db.execute(text(f"SELECT * FROM events WHERE city = '{city}'"))
```

The f-string runs before SQLAlchemy sees anything, so the library cannot help. Escaping by hand is fragile (quoting rules, encodings, numeric contexts with no quotes at all). Also, `text()` with an f-string looks safe in review because it uses SQLAlchemy. Treat any `text(f"...")` or `text("..." + x)` as a bug. Bandit flags string-built SQL as B608 (section 8).

Identifiers cannot be bound. Column names in `ORDER BY` and table names are not values, so placeholders do not work for them. Map user input to an allow-list instead:

```python
SORTABLE = {"date": Event.starts_at, "title": Event.title, "price": Event.price}

@router.get("/events", response_model=list[EventOut])
async def list_events(db: DbSession, sort: Literal["date", "title", "price"] = "date"):
    stmt = select(Event).order_by(SORTABLE[sort], Event.id).limit(20)
    return (await db.scalars(stmt)).all()
```

`Literal` makes FastAPI reject anything else with a 422, and the dict lookup means user text never reaches the SQL.

### Pydantic v2 as the validation boundary

Validate on the way in, as early as possible, with types that encode business rules. Constrained types make the rule part of the schema, so it shows in OpenAPI and cannot be skipped.

```python
from typing import Annotated
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints

class StrictInput(BaseModel):
    """Base for every request body."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

Title = Annotated[str, StringConstraints(min_length=3, max_length=200)]
SeatCount = Annotated[int, Field(strict=True, ge=1, le=10)]
Capacity = Annotated[int, Field(strict=True, gt=0, le=50_000)]
PositiveId = Annotated[int, Field(strict=True, gt=0)]

class EventCreate(StrictInput):
    title: Title
    starts_at: AwareDatetime          # rejects naive datetimes
    capacity: Capacity

class BookingCreate(StrictInput):
    event_id: PositiveId
    seats: SeatCount
```

These models were run through FastAPI's `TestClient`. Results:

| Request body | Result | Error type |
| --- | --- | --- |
| `{"event_id": 1, "seats": 2}` | 200 | none |
| `{"event_id": 1, "seats": "2"}` | 422 | `int_type` (strict field refuses the string) |
| `{"event_id": 1, "seats": 50}` | 422 | `less_than_equal` |
| `{"event_id": 1, "seats": 2, "status": "confirmed"}` | 422 | `extra_forbidden` |
| `EventCreate` with `"starts_at": "2026-12-01T19:00:00"` | 422 | `timezone_aware` |

Strict mode matters because lax mode quietly converts `"2"` to `2` and `true` to `1`. That is convenient, but it hides client bugs and widens what an attacker can send. Apply `strict=True` per field (as above) rather than on the whole model. Under FastAPI, model-wide strict mode also rejects ISO datetime strings in JSON bodies, because FastAPI validates the parsed Python dict, where a datetime is still a `str`. This was confirmed with Pydantic 2.13 and FastAPI 0.161.

### `extra="forbid"` against mass assignment

Pydantic's default is `extra="ignore"`: unknown keys are silently dropped. That already prevents them from reaching your model, so why forbid? Two reasons. First, a 422 tells you someone is probing (`is_admin`, `status`, `price`) and makes it visible in logs. Second, it protects you from future mistakes: if a developer later adds `status` to a shared model, "ignore" would suddenly start accepting it, while "forbid" on a dedicated input model never had it in the first place.

The real defence is the next rule: input models contain only fields the client is allowed to set.

### Separate input and output schemas

One model per direction and per audience. Never return ORM objects without a `response_model`, and never accept the same model you return.

```python
class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: str
    display_name: str
    # password_hash, is_admin, failed_logins are simply not here

class BookingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_id: int
    seats: int
    status: BookingStatus
    created_at: AwareDatetime

class AdminBookingOut(BookingOut):
    user_id: int                      # only the admin view shows who booked

@router.get("/users/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user                       # FastAPI filters through UserOut
```

`response_model` filters the output: FastAPI validates the return value against `UserOut` and serializes only its fields. Even if a future ORM column holds a secret, it cannot leak through this route. Server-controlled fields (`status`, `created_at`, `user_id`) appear only in output models; the service layer sets them.

### Validate the worker's input too

The Kafka consumer is an entry point. Parse every `booking.created` message into a Pydantic model before acting on it, and send messages that fail to a dead-letter topic instead of crashing the loop.

```python
class BookingCreatedEvent(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)   # tolerate new producer fields
    booking_id: PositiveId
    user_id: PositiveId
    event_id: PositiveId
    seats: SeatCount
    occurred_at: AwareDatetime

try:
    evt = BookingCreatedEvent.model_validate_json(msg.value)
except ValidationError:
    await send_to_dlq(msg)
    continue
```

Here `extra="ignore"` is deliberate: message schemas evolve, and a consumer that forbids new fields would break on every producer upgrade.

**Pitfalls**

- `text(f"...")` or `.format()` in SQL, including in Alembic data migrations and admin scripts.
- Binding values but building `ORDER BY` or column lists from raw user input.
- Returning `dict(row)` or `user.__dict__` from a route; it bypasses the output schema.
- Reusing one `Booking` schema for create, update and read, so server fields become writable.
- Model-wide `strict=True` under FastAPI breaking datetime and UUID fields; use per-field strict.
- Validating length but not range: a `seats` value of `-5` can add seats back to an event.

## 4. Browser-facing concerns: CORS, CSRF, headers and TLS

If a browser frontend calls the booking API, the browser becomes part of your security model. CORS, CSRF defences and security headers are instructions to the browser. They protect your users from other websites. They do not protect your API from `curl`, scripts or bots.

### CORS: what it does and does not protect

Browsers apply the same-origin policy: JavaScript on `https://evil.example` may send a request to your API, but it cannot read the response unless your API says that origin is allowed. CORS (Cross-Origin Resource Sharing) is how the API says so, through `Access-Control-Allow-*` response headers. For "non-simple" requests (JSON bodies, `Authorization` header, `DELETE`), the browser first sends an `OPTIONS` preflight and only proceeds if the answer allows it.

What CORS does **not** do:

- It is not authentication or authorization. Any non-browser client ignores it completely.
- It does not stop a "simple" cross-site request (a form POST) from being *sent*; it only stops the attacking page from reading the result. That is why CSRF is a separate problem.
- A wildcard origin is not "less secure" for a truly public, read-only, cookie-free API. The danger is wildcard plus credentials, or reflecting any `Origin` back.

In FastAPI, `CORSMiddleware` comes from Starlette. Its defaults are restrictive: `allow_methods` defaults to `['GET']`, `allow_headers` to `[]`, `allow_credentials` to `False`, and `max_age` to 600 seconds. When `allow_credentials=True`, the docs require origins, methods and headers to be listed explicitly, because browsers refuse a `*` response on credentialed requests.

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,   # e.g. ["https://app.booking.kz", "http://localhost:5173"]
    allow_credentials=True,                # only if the frontend sends cookies
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "X-CSRF-Token"],
    max_age=600,
)
```

A quick test of this configuration with `TestClient`: a request with `Origin: https://app.example.kz` got `access-control-allow-origin` echoed back and `access-control-allow-credentials: true`; a request from `Origin: https://evil.example` got no CORS headers at all, so a browser would block the read.

Load `cors_origins` from settings so dev, staging and prod have different lists. If your frontend uses bearer tokens in the `Authorization` header (not cookies), you can leave `allow_credentials=False`.

### CSRF: when it matters

CSRF (cross-site request forgery) works because browsers attach cookies automatically. If your API authenticates with a cookie, a malicious page can make the user's browser send `POST /bookings/42/cancel` with that cookie attached. The attacker never sees the response, but the side effect happens.

Decision rule:

| How the client authenticates | CSRF risk | What to do |
| --- | --- | --- |
| `Authorization: Bearer <token>` header, token kept in memory by the SPA | None from CSRF; browsers do not add this header automatically | Focus on XSS, which could steal the token |
| Session or JWT in a cookie | Real | `SameSite=Lax` or `Strict`, plus a CSRF token or a required custom header |
| Mobile or server-to-server client | None | Not a browser concern |

Cookie attributes for a cookie-based setup:

```python
response.set_cookie(
    "refresh_token", token,
    httponly=True,          # JavaScript cannot read it, limits XSS theft
    secure=True,            # only sent over HTTPS
    samesite="strict",      # not sent on any cross-site request
    path="/auth/refresh",   # only sent to the one route that needs it
    max_age=60 * 60 * 24 * 7,
)
```

`SameSite=Lax` blocks cookies on cross-site POSTs but still sends them on top-level GET navigations, so it fails if any GET changes state. It is also scoped to the registrable domain, so a compromised sibling subdomain counts as "same site". OWASP treats SameSite as defence in depth, not a complete fix. Add one of:

- **Signed double-submit token**: the server issues a token (HMAC of the session ID and a random value) that the frontend sends back in an `X-CSRF-Token` header; the server recomputes and compares with `hmac.compare_digest`.
- **Required custom header**: reject state-changing requests that lack a custom header. A cross-site page cannot add custom headers without a CORS preflight, which your strict origin list will refuse. This only holds while CORS stays strict.

And never change state on `GET`.

### Security headers

A JSON API needs fewer headers than an HTML site, but a few are cheap and worth adding to every response:

| Header | Value for the booking API | Why |
| --- | --- | --- |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | Browser refuses plain HTTP to your domain for two years; defeats TLS-stripping |
| `X-Content-Type-Options` | `nosniff` | Browser will not reinterpret JSON as HTML or script |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` | If any response is rendered as a page, nothing loads and it cannot be framed |
| `Cache-Control` | `no-store` (on authenticated responses) | Shared caches and browsers do not keep personal data |
| `Referrer-Policy` | `no-referrer` | URLs are not leaked to third parties |

CSP really matters on HTML: the Swagger UI page, an admin page, or email templates you render. For pure JSON it is a backstop. HSTS only has effect over HTTPS, so set it at the proxy or in the app behind a TLS proxy.

```python
SECURITY_HEADERS = {
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}

@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)   # a route can still override
    return response
```

One trap appeared while testing this: the headers were present on normal responses but **missing on the 500 response** produced by a global `Exception` handler. Starlette handles unhandled exceptions in its outermost error middleware, outside the `@app.middleware` stack, so add the same headers inside that handler (or set them at the reverse proxy, which covers every response).

If you keep `/docs` in production, the Swagger UI loads scripts from a CDN, so the strict CSP above would break it. That is another reason to disable docs in prod or serve them on an internal-only path.

### HTTPS and TLS basics

TLS gives you confidentiality (nobody on the network reads tokens), integrity (nobody alters the booking in flight) and server authentication (the client knows it reached your server). In the capstone, terminate TLS at a reverse proxy (Caddy, Nginx or Traefik) in front of Uvicorn:

- The proxy holds the certificate, redirects HTTP to HTTPS, sets HSTS and enforces a body size limit.
- Uvicorn listens only on the internal Docker network, not on a published port.
- Run Uvicorn with `--proxy-headers --forwarded-allow-ips=<proxy IP>` so `request.client.host` and the scheme come from `X-Forwarded-*`, but only when the request came from the proxy. Trusting forwarded headers from anyone lets clients spoof their IP, which breaks per-IP rate limiting.
- Add `TrustedHostMiddleware(allowed_hosts=["api.booking.kz"])` so requests with a forged `Host` header get a 400.

Inside Docker Compose, traffic between API, Postgres, Redis and Kafka is plain text on a private network. That is acceptable for a capstone; in production you would enable TLS to managed databases too.

**Pitfalls**

- `allow_origins=["*"]` with `allow_credentials=True`, or a regex like `.*booking.*` that also matches `booking.evil.com`.
- Believing CORS blocks bots. It only instructs browsers.
- Moving tokens into cookies for "security" without adding CSRF protection.
- Setting HSTS with `preload` before every subdomain is ready for HTTPS; it is hard to undo.
- Security headers set in app middleware but not on error responses.

## 5. Resource consumption and abuse

Every request should have a ceiling on how often, how big, how long and how expensive it can be. Missing ceilings turn a single client into a denial-of-service attack, and on a ticket release day the "attacker" may simply be your own popularity. Put coarse limits at the edge and precise limits in the app.

| Dimension | Where to cap it | Capstone value (a starting point) |
| --- | --- | --- |
| Request rate | Proxy (per IP) and app (per user, per route) | 60/min reads, 10/min `POST /bookings`, 5/min login |
| Body size | Proxy (`client_max_body_size` in Nginx) plus app check | 64 KB for JSON |
| Page size | Query parameter `le=` constraint | `limit <= 100`, `offset <= 10_000` |
| String and list sizes | Pydantic `max_length` | Titles 200 chars, at most 50 IDs per batch |
| Query time | Postgres `statement_timeout` | 5 seconds for the API role |
| Outbound calls | `httpx.Timeout` | 5 s total, 2 s connect |
| Concurrency | Uvicorn `--limit-concurrency`, DB pool size | Returns 503 instead of falling over |
| Container | Compose `deploy.resources.limits` | Memory and CPU per service |

### Rate limiting

A rate limiter counts requests per key (user ID, API key, or IP) per time window and returns **429 Too Many Requests** with a `Retry-After` header when the count is exceeded. Redis is the natural store: it is shared by all API replicas and its `INCR` is atomic.

The simplest algorithm is a fixed window: one counter per key per minute. It allows a burst of up to twice the limit at the boundary between windows, which is fine for most endpoints. Sliding windows or token buckets smooth that out if you need it. Libraries such as SlowAPI or fastapi-limiter implement these; writing one yourself is a good exercise:

```python
import time
from fastapi import Depends, HTTPException, Request
from redis.asyncio import Redis

def rate_limit(scope: str, limit: int, window_s: int = 60):
    async def dependency(request: Request, redis: RedisDep, user: OptionalUser) -> None:
        who = f"user:{user.id}" if user else f"ip:{request.client.host}"
        bucket = int(time.time() // window_s)
        key = f"rl:{scope}:{who}:{bucket}"
        async with redis.pipeline(transaction=True) as pipe:
            pipe.incr(key)
            pipe.expire(key, window_s, nx=True)   # set TTL only on the first hit
            count, _ = await pipe.execute()
        if count > limit:
            retry = window_s - int(time.time()) % window_s
            raise HTTPException(429, "Too many requests", headers={"Retry-After": str(retry)})
    return dependency

@router.post("/bookings", dependencies=[Depends(rate_limit("book", limit=10))])
async def create_booking(...): ...
```

The counter logic was run against an in-memory Redis fake: with a limit of 3, five calls returned `[True, True, True, False, False]`.

Design choices that matter:

- **Key by user when authenticated, by IP otherwise.** IP-only limits punish everyone behind a university NAT and are easy to dodge with many IPs.
- **Trust the client IP only from your proxy.** Uvicorn's `--forwarded-allow-ips` must name the proxy; otherwise clients forge `X-Forwarded-For` and get a fresh limit per request.
- **Different limits per route.** Login and booking are expensive or sensitive; reads are cheap.
- **Decide fail-open or fail-closed.** If Redis is down, do you allow traffic (availability) or reject it (safety)? For login, fail closed; for event browsing, fail open and log loudly.

Rate limits are not the full answer to API6 (business-flow abuse). A bot with 500 accounts stays under every per-user limit. You still need per-event caps and anomaly alerts.

### Pagination limits

Every list endpoint needs a maximum page size enforced on the server. Use `Query(ge=1, le=100)` as in API4, and add a stable `ORDER BY` (with `id` as a tie-breaker) so pages do not overlap. Large offsets are expensive in Postgres because skipped rows are still read. For deep lists, switch to keyset (cursor) pagination: `WHERE (starts_at, id) > (:last_starts_at, :last_id) ORDER BY starts_at, id LIMIT :limit`. It stays fast at any depth and makes scraping slower too.

### Request size limits

Uvicorn does not cap request body size by default. Set the main limit at the reverse proxy (`client_max_body_size 64k;` in Nginx, `request_body { max_size 64KB }` in Caddy) so oversized bodies never reach Python. Add an app-level check as a second layer:

```python
MAX_BODY = 64 * 1024

@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    length = request.headers.get("content-length")
    if length is not None and int(length) > MAX_BODY:
        return JSONResponse({"title": "Payload Too Large", "status": 413}, status_code=413)
    return await call_next(request)
```

This only checks the declared length. A chunked request has no `Content-Length`, which is why the proxy limit is the real control. Also cap sizes inside the body with Pydantic: `max_length` on strings and lists, so a 60 KB body cannot hold 10,000 event IDs.

### Timeouts

A request without a timeout holds a worker, a DB connection and memory for as long as the slowest dependency wants. Set timeouts at every hop:

```python
from sqlalchemy.ext.asyncio import create_async_engine

engine = create_async_engine(
    settings.database_url,
    pool_size=10, max_overflow=5, pool_timeout=5,          # wait at most 5 s for a connection
    connect_args={"server_settings": {"statement_timeout": "5000"}},   # asyncpg: ms
)

HTTP_TIMEOUT = httpx.Timeout(5.0, connect=2.0)

async def with_deadline(coro, seconds: float = 10.0):
    async with asyncio.timeout(seconds):                 # Python 3.11+
        return await coro
```

You can also set the timeout on the role itself: `ALTER ROLE booking_app SET statement_timeout = '5s';`. Then it applies no matter which client connects.

### Expensive query protection

Some endpoints are expensive by design: full-text search, "events near me", admin reports. Protect them:

- Require at least one selective filter (date range or city) and cap the date range (for example 90 days).
- Index what you filter and sort on; check with `EXPLAIN ANALYZE` that the planner uses it.
- Avoid `ILIKE '%term%'` on large tables. Use a trigram index or Postgres full-text search.
- Cache hot, public reads (event list for the next week) in Redis for a few seconds. Even 5 seconds of caching absorbs a release-day spike.
- Move heavy work (sending emails, generating PDFs) to the Kafka worker, so the HTTP request stays cheap.
- Watch costs on third-party calls: an endpoint that sends an email per request is a spending attack if it is not rate-limited.

**Pitfalls**

- A rate limiter keyed on `X-Forwarded-For` read directly from the request headers.
- `limit` validated on one list endpoint and forgotten on the others; use a shared `Page` dependency.
- Counting rate limits in process memory, which resets on restart and is not shared across replicas.
- No `statement_timeout`, so one slow report query holds a pool connection until the pool is exhausted.
- Returning 500 instead of 429, which hides abuse in error metrics.

## 6. SSRF and unsafe consumption of third-party APIs

Whenever your server makes an outbound request, two things can go wrong. The destination can be chosen by an attacker (SSRF, API7), or the response can be shaped by an attacker (unsafe consumption, API10). Both come from the same mistake: treating the network beyond your API as trusted.

### How SSRF works

Your API container can reach places the public internet cannot: `postgres:5432`, `redis:6379`, `kafka:9092` on the Compose network, `localhost` admin ports, and in the cloud the instance metadata service at `169.254.169.254`, which can hand out credentials. If a user can make your server send a request to a URL they choose, they borrow that network position. Even "blind" SSRF, where they never see the response, lets them scan internal ports by timing.

The capstone has no URL-fetching feature yet. It gains one the moment you add "organizer webhook: we POST to your URL when someone books", "import event from URL" or "avatar from URL".

### Fix pattern 1: an allow-list when you know the destinations

If the set of hosts is known (your email provider, a payment gateway, an OAuth provider), do not take a URL from the user at all. Store the base URL in settings and let the user choose only an identifier.

```python
PROVIDERS = {
    "google": "https://openidconnect.googleapis.com/v1/userinfo",
    "github": "https://api.github.com/user",
}

async def fetch_profile(provider: Literal["google", "github"], token: str) -> dict:
    url = PROVIDERS[provider]                 # user picks a key, never a URL
    ...
```

### Fix pattern 2: validate user-supplied URLs (webhooks)

Webhooks are the hard case: the destination is arbitrary by design, so an allow-list is impossible. OWASP's SSRF cheat sheet calls the fallback, deny-lists, "bypass-prone", so layer several checks:

1. Accept `https` only, with a host, no embedded credentials, and only port 443.
2. Resolve the hostname and reject it if **any** resolved address is not public. Python's `ipaddress` module does the classification: `is_global` is `False` for loopback, RFC 1918 private ranges, link-local (including `169.254.169.254`), carrier-grade NAT (`100.64.0.0/10`), unique-local IPv6 and IPv4-mapped loopback.
3. Validate at registration time **and** again at send time, because DNS can change in between.
4. Disable redirects. A public URL can redirect to `http://169.254.169.254/`. In httpx, `follow_redirects` already defaults to `False`; keep it that way.
5. Short timeouts, a response size cap, and do not return the upstream body to the user.
6. Best of all, enforce it at the network level: run the webhook sender in a container whose only route out is an egress proxy that blocks private ranges.

```python
import asyncio, ipaddress, socket
from urllib.parse import urlsplit

class UnsafeURL(ValueError):
    pass

async def assert_public_https(url: str) -> list[str]:
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise UnsafeURL("only https URLs with a host are allowed")
    if parts.username or parts.password:
        raise UnsafeURL("credentials in URL are not allowed")
    if (parts.port or 443) != 443:
        raise UnsafeURL("only port 443 is allowed")
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(parts.hostname, 443, type=socket.SOCK_STREAM)
    ips = sorted({info[4][0] for info in infos})
    if not ips or not all(ipaddress.ip_address(ip).is_global for ip in ips):
        raise UnsafeURL("destination is not a public address")
    return ips
```

This validator was run against several inputs. `https://localhost/x`, `https://10.0.0.5/`, `https://[::1]/` and `https://169.254.169.254/latest` were rejected as non-public; `http://example.com` was rejected for the scheme; `https://user:pw@example.com/` for embedded credentials; and `https://example.com:8080/` for the port.

It has one known gap: DNS rebinding. An attacker's DNS server can answer with a public IP for your check and a private IP a second later when httpx connects. The complete fix is to connect to the IP you validated while keeping the hostname for TLS verification, or to use the egress proxy from step 6. For the capstone, document the gap in your README; that is an honest and acceptable answer.

Also sign outgoing webhooks (an HMAC of the body with a per-organizer secret in a header) so receivers can verify they came from you. That protects your users, and it is the same pattern you should require from anyone who sends webhooks *to* you.

### Consuming third-party APIs safely

Treat every upstream response as untrusted input. The OAuth provider, the email service and any partner API can be compromised, misconfigured or simply return something unexpected.

```python
class OAuthProfile(BaseModel):
    model_config = ConfigDict(extra="ignore")
    sub: Annotated[str, StringConstraints(min_length=1, max_length=255)]
    email: Annotated[str, StringConstraints(max_length=320)]
    email_verified: bool = False
    name: Annotated[str, StringConstraints(max_length=100)] | None = None

UPSTREAM_TIMEOUT = httpx.Timeout(5.0, connect=2.0)

async def get_profile(client: httpx.AsyncClient, url: str, access_token: str) -> OAuthProfile:
    resp = await client.get(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=UPSTREAM_TIMEOUT,
        follow_redirects=False,
    )
    resp.raise_for_status()
    if len(resp.content) > 64_000:
        raise UpstreamError("profile response too large")
    try:
        return OAuthProfile.model_validate_json(resp.content)
    except ValidationError as exc:
        raise UpstreamError("unexpected profile shape") from exc
```

Here `extra="ignore"` is the right choice (unlike request bodies): providers add fields over time and you only want the ones you model. The rules that make this safe:

- **Validate shape and size** with a Pydantic model, as for a request body.
- **Use only what you need**, and decide trust per field. Link accounts by the provider's stable `sub`, not by email, and only trust email when `email_verified` is true.
- **Timeouts and failure modes.** httpx's default is 5 seconds of inactivity, but set it explicitly so it is visible in review. Decide what your API does when the provider is down: return 503, not a hung request.
- **Never pass upstream text into SQL, shell or HTML** without the same handling as user input. A display name containing `<script>` is harmless in JSON and dangerous if an admin page renders it raw.
- **TLS on, verification on.** Never `verify=False`, even "temporarily".
- **Limit what you send.** Do not forward user PII to a third party unless the feature needs it.

**Pitfalls**

- Validating a webhook URL only when it is saved, not when it is used.
- Allowing `http://` "for local testing" and shipping it.
- Following redirects from an upstream that you validated only at the first hop.
- Returning the upstream error body to the client, which turns blind SSRF into a full read.
- Using the email from an OAuth profile as the account key without checking `email_verified`.

## 7. Secrets management

A secret is any value that grants access: the JWT signing key, DB and Kafka passwords, SMTP or email-provider API keys, webhook signing secrets. The rules are simple: secrets live outside the code, enter the process at runtime, are never logged, can be rotated, and each one grants as little as possible.

### Config from the environment with pydantic-settings

The twelve-factor approach puts config in environment variables. `pydantic-settings` reads them into a typed, validated object, so a missing or malformed secret fails at startup instead of at the first request that needs it.

```python
from functools import lru_cache
from typing import Literal
from pydantic import Field, PostgresDsn, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="BOOKING_",
        env_file=".env",              # local dev only; real env vars win over it
        secrets_dir="/run/secrets",   # Docker secrets: one file per value
        extra="ignore",
    )

    env: Literal["dev", "test", "prod"] = "dev"
    database_url: PostgresDsn
    jwt_secret: SecretStr = Field(min_length=32)
    kafka_sasl_password: SecretStr | None = None
    cors_origins: list[str] = []

@lru_cache
def get_settings() -> Settings:
    return Settings()
```

What each piece buys you:

- **`SecretStr`** prints as `SecretStr('**********')` in `repr`, logs and tracebacks. You must call `.get_secret_value()` to use it, which makes every use visible in review.
- **`Field(min_length=32)`** rejects a weak dev secret like `"secret"` at startup. Tested: with `BOOKING_JWT_SECRET` unset, `Settings()` raised `ValidationError: jwt_secret Field required`.
- **Priority**: real environment variables override `.env` values, and both override files in `secrets_dir`.
- **`secrets_dir`** reads Docker or Kubernetes secrets mounted as files. The file name must include the prefix: with `env_prefix="BOOKING_"`, the file is `/run/secrets/booking_jwt_secret`.
- **`list[str]`** fields are parsed from JSON, so `BOOKING_CORS_ORIGINS='["https://app.booking.kz"]'`.

In Docker Compose, pass values with `env_file:` or Compose `secrets:`. Do not bake them into the image with `ENV` or `ARG` in the Dockerfile: anyone who pulls the image can read its layers with `docker history`.

### Never commit secrets

Once a secret is pushed it is compromised, even if you delete it in the next commit, because git history keeps it. Prevention has three layers:

1. **`.gitignore`** the local files: `.env`, `.env.*` (but commit `.env.example` with placeholder values), `secrets/`, `*.pem`, `*.key`.
2. **A pre-commit hook** that scans staged changes and blocks the commit. Gitleaks and detect-secrets are the common choices.
3. **Server-side scanning.** GitHub secret scanning and push protection catch what slipped past local hooks (a teammate without the hook installed).

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.24.2            # run `pre-commit autoupdate` to move to the latest release
    hooks:
      - id: gitleaks
  - repo: https://github.com/PyCQA/bandit
    rev: 1.9.4
    hooks:
      - id: bandit
        args: ["-c", "pyproject.toml"]
        additional_dependencies: ["bandit[toml]"]
```

Run `pre-commit install` once per clone. If a secret does leak: rotate it first, then clean history. Cleaning history alone is not enough because forks, clones and caches already have it.

### Rotation

Design for rotation before you need it, because an emergency is the worst time to discover that changing the JWT key logs out every user and breaks the worker.

- **JWT signing keys**: support more than one key. Put a key ID (`kid`) in the token header, sign with the newest key, and verify with any key in the active set. To rotate: add the new key, switch signing to it, wait one access-token lifetime, then remove the old one.
- **Database passwords**: create the new password (or a second role), deploy with it, then drop the old one. Postgres supports `ALTER ROLE ... PASSWORD` without downtime.
- **Third-party API keys**: most providers allow two active keys at once for this reason.
- Write the rotation steps for each secret in the README. A procedure that exists only in your head does not exist.

### Least privilege for database users

The API does not need to create tables. If it can, a single SQL injection becomes `DROP TABLE bookings`. Use separate roles:

```sql
-- Owner role: runs Alembic migrations, owns the schema. Used only by the migrate job.
CREATE ROLE booking_owner LOGIN PASSWORD :'owner_pw';
CREATE SCHEMA booking AUTHORIZATION booking_owner;

-- App role: data access only, no DDL.
CREATE ROLE booking_app LOGIN PASSWORD :'app_pw';
GRANT USAGE ON SCHEMA booking TO booking_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA booking TO booking_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA booking TO booking_app;
ALTER DEFAULT PRIVILEGES FOR ROLE booking_owner IN SCHEMA booking
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO booking_app;
ALTER ROLE booking_app SET statement_timeout = '5s';

-- Worker role: only what notifications need.
CREATE ROLE booking_worker LOGIN PASSWORD :'worker_pw';
GRANT USAGE ON SCHEMA booking TO booking_worker;
GRANT SELECT ON booking.bookings, booking.users, booking.events TO booking_worker;
```

Go further where it is cheap: the app role may not need `DELETE` on `bookings` if cancellation is a status change, and an audit-log table can be insert-only for the app. Apply the same idea to Kafka (the API may only produce to `booking.created`; the worker may only consume it) and to Redis (ACL users, or at least a password and no public port).

**Pitfalls**

- A default like `jwt_secret: str = "changeme"` in `Settings`; production silently runs with it if the env var is missing.
- Logging `settings` or `os.environ` at startup "for debugging".
- Committing `.env` once "just for the demo".
- Running the API as the Postgres superuser because it was quicker in week 2.
- Secrets in `docker-compose.yml` itself, which is committed. Reference an `env_file` instead.
- Rotating a key by editing it in place, which breaks every live token at once.

## 8. Supply chain and static analysis

Most of the code running in your API is not yours: FastAPI, Starlette, SQLAlchemy, asyncpg, aiokafka and their dependencies. A known vulnerability in any of them is a vulnerability in your API. Two cheap tools cover the basics: pip-audit checks your dependencies against vulnerability databases, and bandit checks your own code for risky patterns. Neither finds logic bugs like BOLA; that is what the manual audit in the capstone section is for.

| Tool | Looks at | Finds | Does not find |
| --- | --- | --- | --- |
| pip-audit | Installed packages or a requirements/lock file | Package versions with published advisories (PyPI advisory database by default, OSV with `-s osv`) | Bugs in your code; unpublished vulnerabilities |
| bandit | Your Python source (AST) | Risky calls: string-built SQL, `shell=True`, `verify=False`, `pickle`, weak hashes, hard-coded passwords | Authorization flaws, business logic, anything needing runtime data |
| Dependabot | Manifests in the repo | Outdated and vulnerable dependencies; opens PRs to bump them | Anything in your code |
| gitleaks (section 7) | Git diffs and history | Committed secrets | Secrets passed at runtime |

### pip-audit

pip-audit resolves your dependency set, then looks up each exact version. It exits with code 1 if anything vulnerable is found, which is what makes it useful in CI.

```bash
pip-audit                                   # audit the current environment
pip-audit -r requirements.lock --strict     # audit a lock file; fail if any dep can't be resolved
pip-audit -r requirements.lock --require-hashes
pip-audit --fix --dry-run                   # show which upgrades would fix the findings
pip-audit -f json -o audit.json             # machine-readable report (also cyclonedx-json, markdown)
pip-audit --ignore-vuln GHSA-xxxx-xxxx-xxxx # accepted risk; write down why in the README
```

When a finding appears, the usual fix is to bump that package. If no fixed version exists, read the advisory: often the vulnerable function is one you do not call. Then ignore that single ID with a comment and a date to revisit, never the whole tool.

### bandit

bandit parses each file into an AST and runs plugins over it. Each finding has a test ID, a severity and a confidence. Running bandit 1.9 against a deliberately bad file produced these findings, which are exactly the ones that matter for the capstone:

| Code | Bandit ID | Severity / confidence |
| --- | --- | --- |
| `text(f"SELECT ... '{city}'")` | B608 hardcoded\_sql\_expressions | Medium / Low |
| `subprocess.run(cmd, shell=True)` | B602 | High / High |
| `httpx.get(url, verify=False)` | B501 request\_with\_no\_cert\_validation | High / High |
| `hashlib.md5(...)` | B324 | High / High |
| `pickle.loads(data)` | B301 | Medium / High |
| `random.choice(...)` for tokens | B311 | Low / High |
| `SECRET_KEY = "hunter2..."` | B105 hardcoded\_password\_string | Low / Medium |
| `assert` | B101 | Low / High |

Useful flags: `-r` to recurse, `-c pyproject.toml` to load config, `-ll` (or `--severity-level medium`) to report medium and above, `-ii` for confidence, `-f json` for reports, and `-b baseline.json` to accept existing findings while blocking new ones.

```toml
# pyproject.toml
[tool.bandit]
exclude_dirs = ["tests", ".venv", "alembic/versions"]
skips = ["B101"]     # assert is fine in this codebase; tests are excluded anyway
```

For a false positive, suppress the one line with a reason: `# nosec B608 - table name from internal allow-list`. A bare `# nosec` hides every check on that line and gives the reviewer nothing.

Note B608 has low confidence: bandit sees string-built SQL but cannot know whether the pieces are safe. Treat each hit as a question to answer, not as noise.

### Pinning and lockfiles

An unpinned `fastapi` in `requirements.txt` means the version you tested and the version you deployed can differ, and a compromised new release goes straight into your next build. Pin everything, including transitive dependencies, in a lock file:

- **uv**: `uv lock` writes `uv.lock`; `uv export --format requirements-txt > requirements.lock` gives pip-audit a file to read.
- **pip-tools**: `pip-compile --generate-hashes requirements.in -o requirements.lock`.
- **Poetry**: `poetry.lock`.

Hashes (`--require-hashes`) make pip refuse a package whose contents changed, which protects against a tampered mirror. In the Dockerfile, install from the lock file, and pin the base image by digest, not just `python:3.12-slim`.

### Dependabot

Dependabot reads your manifests and opens PRs. Security updates fire when an advisory affects you; version updates keep you current on a schedule so security bumps stay small. Configure it in `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "pip"          # use "uv" if the project uses uv.lock
    directory: "/"
    schedule:
      interval: "weekly"
    groups:
      python-minor-and-patch:
        update-types: ["minor", "patch"]
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
  - package-ecosystem: "docker"
    directory: "/"
    schedule:
      interval: "weekly"
```

Grouping minor and patch bumps keeps the PR count manageable. Your CI (tests plus the security job below) is what makes merging those PRs safe.

### Putting it in GitHub Actions

```yaml
# .github/workflows/security.yml
name: security
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "0 3 * * 1"        # weekly, catches new advisories for unchanged code

permissions:
  contents: read               # least privilege for GITHUB_TOKEN

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Install tools
        run: python -m pip install pip-audit "bandit[toml]"
      - name: Dependency audit
        run: pip-audit -r requirements.lock --strict --desc
      - name: Static analysis
        run: bandit -c pyproject.toml -r app -ll

  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0       # scan full history, not just the last commit
      - uses: gitleaks/gitleaks-action@v3
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # GITLEAKS_LICENSE: ${{ secrets.GITLEAKS_LICENSE }}  # needed only for organization repos
```

There is also an official `pypa/gh-action-pip-audit` action if you prefer it to the CLI. Points worth noticing in this workflow:

- The **scheduled run** matters: a dependency that was clean on Monday can get an advisory on Thursday with no commit from you.
- **`permissions: contents: read`** limits what a compromised step can do with the token. GitHub's hardening guide recommends read-only by default.
- For stronger supply-chain hygiene, pin third-party actions to a full commit SHA instead of a tag; tags can be moved. Dependabot's `github-actions` ecosystem keeps those SHAs updated.
- Make the job a required status check on `main` in branch protection, or it is advice, not a gate.

**Pitfalls**

- Running pip-audit against the CI runner's environment instead of your lock file, so it audits the wrong set.
- `--exit-zero` or `|| true` added "temporarily" to get a red build green.
- Blanket `# nosec` or `skips` for whole categories like B608.
- Lock file in the repo, but Dockerfile installs from the unpinned `requirements.in`.
- Assuming a clean pip-audit means a secure app; it says nothing about your own logic.

## 9. Logging, monitoring and error handling

Errors and logs pull in opposite directions. Clients should learn as little as possible about your internals; operators should learn as much as possible, minus secrets and personal data. The pattern: a generic, structured error for the client, carrying an ID that points to a detailed, structured log entry on the server.

### Errors without internals: Problem Details

RFC 9457 (which replaced RFC 7807) defines a standard JSON error body with the media type `application/problem+json`. Its members are `type` (a URI for the kind of problem, `about:blank` if you have none), `title` (a short summary that does not change between occurrences), `status`, `detail` (specific to this occurrence, written to help the client fix it) and `instance` (an identifier for this occurrence). Its security section warns against exposing implementation internals like stack traces.

FastAPI's defaults are close but not quite there: HTTP errors return `{"detail": ...}`, and validation errors echo the rejected `input` back, which can reflect a password someone pasted into the wrong field. Unhandled exceptions become a plain 500, but with `debug=True` you get a traceback in the response. Override all three handlers:

```python
import uuid
from http import HTTPStatus
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

PROBLEM = "application/problem+json"

def problem(status: int, detail: str | None = None, **extra) -> JSONResponse:
    body = {"type": "about:blank", "title": HTTPStatus(status).phrase, "status": status}
    if detail:
        body["detail"] = detail
    body.update(extra)
    return JSONResponse(body, status_code=status, media_type=PROBLEM, headers=SECURITY_HEADERS)

@app.exception_handler(StarletteHTTPException)       # covers 404 for unknown routes too
async def http_error(request: Request, exc: StarletteHTTPException):
    return problem(exc.status_code, str(exc.detail))

@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    errors = [{"loc": e["loc"], "type": e["type"], "msg": e["msg"]} for e in exc.errors()]
    return problem(422, "Request body or parameters are invalid", errors=errors)   # no 'input'

@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception):
    error_id = uuid.uuid4().hex
    log.error("unhandled exception", exc_info=exc,
              extra={"ctx": {"error_id": error_id, "path": request.url.path}})
    return problem(500, instance=f"urn:error:{error_id}")
```

When tested, `GET /boom` (which raises `RuntimeError("password=hunter2")`) returned `{"type": "about:blank", "title": "Internal Server Error", "status": 500, "instance": "urn:error:1700cd..."}`. The traceback, including the fake password in the exception message, went only to the server log under the same ID. That second fact is a warning too: exception messages can carry secrets into logs, so never build them from connection strings or tokens.

A few more error-handling rules:

- Be consistent about 404 vs 403. For objects the caller does not own, return 404 so IDs cannot be probed.
- Use 409 for business conflicts ("Not enough seats"), 429 for rate limits, 503 when a dependency is down.
- Never put SQL error text in `detail`. `IntegrityError` messages reveal table and constraint names.

### Structured logs without secrets or PII

Log in JSON, one object per line. Structured logs are searchable, and JSON encoding neutralizes log injection: a username containing a newline cannot forge a second log line, because the newline is escaped inside a string.

```python
import json, logging

REDACT = {"password", "token", "access_token", "refresh_token", "authorization", "cookie", "secret"}

class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": request_id_var.get(None),      # set by a middleware via ContextVar
        }
        for key, value in getattr(record, "ctx", {}).items():
            entry[key] = "[REDACTED]" if key.lower() in REDACT else value
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)
```

The redaction list is a safety net, not the strategy. The strategy is to log identifiers, not content:

| Log this | Not this |
| --- | --- |
| `user_id=42` | email, full name, phone |
| `booking_id`, `event_id`, `seats` | the whole request body |
| `token_jti` or a hash prefix | the JWT or refresh token |
| route template `/bookings/{booking_id}` | full URL with query string (may hold tokens) |
| `error_id` plus exception type | `settings`, `os.environ`, DB DSN |

Add a middleware that assigns a `request_id` (or accepts a validated one from the proxy), returns it in an `X-Request-ID` header, and puts it in every log line. Pass it into the Kafka message headers too, so you can follow one booking from HTTP request to worker notification.

Libraries such as structlog or python-json-logger do the formatting for you; the rules above still apply.

### Audit logs for security events

An audit log answers "who did what, to what, when, from where, and did it work?" It is a separate stream (its own logger or table), append-only for the app, and kept longer than debug logs. OWASP's logging cheat sheet lists the categories worth recording. For the capstone:

- `auth.login_succeeded`, `auth.login_failed` (with reason category, not the password), `auth.token_refreshed`, `auth.logout`, `auth.password_changed`.
- `authz.denied`: any 403, and any 404 from an ownership check. A burst of these from one user is a BOLA probe.
- `booking.created`, `booking.cancelled`, `event.created`, `event.updated` by admins or organizers.
- `ratelimit.exceeded` and `validation.rejected` with `extra_forbidden` errors (someone sending `is_admin`).

```python
audit = logging.getLogger("booking.audit")

audit.info("login failed", extra={"ctx": {
    "event": "auth.login_failed",
    "user_id": user.id if user else None,
    "ip": request.client.host,
    "reason": "bad_password" if user else "unknown_user",   # internal only; client sees one generic message
}})
```

### Monitoring and alerting on anomalies

Logs nobody reads do not protect anything. Turn the important signals into metrics and alerts:

| Signal | Example alert | Likely meaning |
| --- | --- | --- |
| `auth.login_failed` rate | over 50/min, or over 10/min for one account | Credential stuffing or brute force |
| `authz.denied` per user | over 20 in 5 min | BOLA or BFLA probing |
| 429 responses | sudden jump | Scraping or a bot at ticket release |
| Bookings per user per event | above the business cap | API6 abuse, or the cap is broken |
| 5xx rate and p95 latency | over baseline | Bug, overload, or a resource-exhaustion attack |
| Kafka consumer lag, DLQ size | growing | Worker stuck or poisoned messages |

For the capstone, exposing Prometheus metrics (for example with `prometheus-fastapi-instrumentator`) and a Grafana dashboard in Docker Compose is enough to demonstrate the idea. Writing the alert rules down, even if they are not wired to a pager, shows you thought about detection.

**Pitfalls**

- Logging request bodies on validation failure, which captures passwords from the login route.
- Returning `str(exc)` to the client "for easier debugging".
- Audit events mixed into debug logs at the same retention, so they rotate away after a day.
- Logging the `Authorization` header in access logs at the proxy.
- Different error shapes from different routes, which leak which framework layer failed.

## Apply it to the capstone

This week's deliverable is an audited, hardened booking API and a README section that explains the security decisions. Work through it in this order: audit first (find), then fix, then automate (so fixes stay fixed), then document.

### Step 1: audit against the ten risks

Fill in the last two columns as you go. Each "test idea" should become a pytest test, so the finding cannot come back. Write the test first, watch it fail, then fix.

| Risk | Where to look in the capstone | Test idea | Finding | Fixed in |
| --- | --- | --- | --- | --- |
| API1 BOLA | Every route with `{booking_id}` or `{user_id}`; service functions that take an ID | User B calls `GET` and `DELETE /bookings/{A's id}`; expect 404 |  |  |
| API2 Broken Authentication | `/auth/*` routes, JWT decode call, refresh-token storage | 20 wrong passwords in a row get 429; unknown email and wrong password return identical bodies; expired token gets 401 |  |  |
| API3 Property-level authz | All Pydantic models; any route returning ORM objects without `response_model` | `POST /bookings` with `"status": "confirmed"` gets 422; `GET /users/me` JSON has no `password_hash` key |  |  |
| API4 Resource consumption | List endpoints, body size, DB engine config, httpx clients | `?limit=1000` gets 422; a 1 MB body gets 413; `SHOW statement_timeout` as the app role |  |  |
| API5 Function-level authz | `/admin/*`, event create/update/delete, any role check | A normal user calls each admin route and gets 403; a test asserts every route has an auth dependency |  |  |
| API6 Business flows | `POST /bookings`, cancellation, sign-up | One user tries to book past the per-event cap and gets 409; 11 bookings in a minute get 429 |  |  |
| API7 SSRF | Any field that holds a URL (webhooks, images); any outbound httpx call | Registering `https://169.254.169.254/` or `https://localhost/` as a webhook gets 422 |  |  |
| API8 Misconfiguration | `main.py` app setup, CORS, headers, `docker-compose.yml` ports, `debug` | Disallowed `Origin` gets no `Access-Control-Allow-Origin`; responses carry `X-Content-Type-Options`; 500 body has no traceback |  |  |
| API9 Inventory | `app.routes`, `/docs`, old versions, leftover debug routes | Snapshot test of the OpenAPI path list; `/docs` gives 404 when `env=prod` |  |  |
| API10 Unsafe consumption | OAuth callback, email-provider client, Kafka consumer | Upstream returns malformed JSON or a 5-second hang; API returns 502 or 503, not 500 or a hang. Malformed Kafka message goes to the DLQ |  |  |

Hints for the audit:

- List all routes in one go: `for r in app.routes: print(getattr(r, "methods", None), r.path)`. Mark each with who may call it and which object it touches. Rows with an ID and no ownership filter are your BOLA candidates.
- For API1, a small fixture that creates two users with one booking each makes every BOLA test a three-liner.
- For API3, grep your routers for `return` statements that return a model instance from a route with no `response_model` or return annotation.
- For API6, think about what a scalper does on release day, then write down which control stops each step.

### Step 2: confirm parameterized queries

- Search for raw SQL: `grep -rn "text(" app/` and `grep -rnE 'f"(SELECT|INSERT|UPDATE|DELETE)' app/`. Every `text()` must use `:named` parameters only.
- Check every dynamic `ORDER BY` or column choice goes through an allow-list dict or `Literal`.
- Let bandit confirm: B608 should report nothing, or only lines with a justified `# nosec B608`.
- Add one test that books seats for an event in a city named `Astana' OR '1'='1` and checks that only one row changes.

### Step 3: lock down Pydantic input models

- Create a `StrictInput` base with `extra="forbid"` and make every request-body model inherit from it.
- Split any shared model into `XCreate`, `XUpdate`, `XOut` (and `XAdminOut` if needed). Server-owned fields appear only in `Out` models.
- Add `response_model` (or a return type annotation) to every route.
- Add constraints: seat counts, string lengths, page sizes, timezone-aware datetimes.
- Test idea: parametrize one test over every input model, send a body with an extra `is_admin` field, and assert 422.

### Step 4: CORS and security headers

- Move CORS origins into `Settings.cors_origins`; no `"*"` anywhere.
- List methods and headers explicitly if `allow_credentials=True`. Decide whether you need credentials at all (bearer token in a header means you do not).
- Add the security-headers middleware, and make sure your 500 handler adds the same headers.
- Add `TrustedHostMiddleware` with your hostnames, and disable `/docs` in prod.
- Hint: one pytest test can loop over three responses (a 200, a 404 and a forced 500) and assert all the headers are present on each.

### Step 5: secrets only from the environment

- `Settings` with `SecretStr` for every secret and no insecure defaults. The app must refuse to start without them.
- `.env` in `.gitignore`; `.env.example` committed with placeholders.
- Compose reads secrets via `env_file:` or `secrets:`; the Dockerfile has no `ENV` with secrets.
- Separate Postgres roles for migrations, API and worker. Check with `\du` and by trying `CREATE TABLE` as the app role (it should fail).
- Run `gitleaks detect` over your full history once. If it finds something real, rotate that secret.

### Step 6: pip-audit and bandit in CI

- Generate a lock file if you do not have one.
- Add the `security.yml` workflow from section 8: pip-audit on the lock file, bandit with `-ll`, gitleaks with full history, weekly schedule, `permissions: contents: read`.
- Add `.github/dependabot.yml` for pip (or uv), GitHub Actions and Docker.
- Make the jobs required status checks on `main`.
- Fix or document every initial finding. An ignored finding needs an ID, a reason and a date in the README.

### Step 7: README security section

Keep it short and factual. A reviewer (or interviewer) should see in two minutes that you thought about security deliberately. Suggested headings:

1. **Threat model**: assets, entry points, trust boundaries (a short list or a small diagram).
2. **Authorization model**: roles, which routes need which role, how ownership is enforced.
3. **Input handling**: Pydantic strict inputs, parameterized queries, limits.
4. **Browser settings**: CORS origins policy, auth transport (header or cookie) and the CSRF stance that follows from it, security headers.
5. **Abuse controls**: rate limits per route, booking caps, timeouts.
6. **Secrets**: where they come from, how to rotate each one, DB roles.
7. **Automated checks**: what runs in CI and on what schedule.
8. **Known gaps and accepted risks**: for example the webhook DNS-rebinding gap, ignored advisories with reasons.

The last heading is the one that shows maturity. Every real system has known gaps; writing them down is what makes them manageable.

## Check yourself

1. What is the difference between API1 (BOLA), API3 (object property level) and API5 (function level)? Give one booking-API example of each.
2. Why return 404 rather than 403 when a user requests a booking they do not own?
3. Your teammate says "we use SQLAlchemy, so we are safe from SQL injection". When is that false?
4. Pydantic already ignores unknown fields by default. Why bother with `extra="forbid"`, and why is it still not enough on its own to prevent mass assignment?
5. What does CORS protect against, and what does it not protect against? Why can't you combine a wildcard origin with credentials?
6. Your SPA sends a JWT in the `Authorization` header. Do you need CSRF protection? What changes if you move the token into a cookie?
7. Rate limits are in place. Why might a scalper still book every seat for a popular event, and what else would you add?
8. An organizer can register a webhook URL. Describe two things an attacker could do with it and three layers of defence.
9. Why is a `CHECK (seats_available >= 0)` constraint useful if your service already locks the row with `SELECT ... FOR UPDATE`?
10. What does pip-audit find that bandit does not, and the reverse? What does neither find?
11. A secret was committed and pushed, then removed in the next commit. What do you do, in what order?
12. What should the client see when an unhandled exception occurs, and what should the server log? How do you link them?

## Answers

1. All three are authorization at different granularity. BOLA: user B reads or cancels user A's booking by changing the ID. Property level: a user sets `status="confirmed"` in the body, or `/users/me` returns `password_hash`. Function level: a normal user calls `POST /admin/events`. Fixes: ownership in the query; separate input/output schemas; role dependencies on routers.
2. A 403 confirms the object exists, which lets an attacker enumerate valid IDs. A 404 looks the same as a non-existent ID, so it reveals nothing.
3. When anyone builds SQL text from strings: `text(f"...")`, `.format()`, string concatenation, or identifiers (`ORDER BY`, column or table names) taken from user input. Bind parameters protect values only; identifiers need an allow-list.
4. "Forbid" turns silent dropping into a visible 422, which exposes probing in logs and catches client bugs. It also guards against a field being added to a shared model later. It is not enough because a field that legitimately exists on the model (like `status` on a shared `Booking` schema) is accepted either way. The real fix is input models that contain only client-settable fields.
5. CORS lets your API tell browsers which other origins' JavaScript may read its responses. It protects users' browsers from malicious sites reading their data. It does not stop non-browser clients, does not authenticate anyone, and does not stop simple cross-site requests from being sent. With a wildcard plus credentials, any website could make authenticated requests as the user and read the result, so browsers reject that combination and Starlette requires explicit lists.
6. No CSRF protection is needed for a header token, because browsers never attach it automatically; the main threat becomes XSS stealing it. In a cookie, browsers attach it automatically, so you need `SameSite` (Lax or Strict), `HttpOnly`, `Secure`, plus a CSRF token or a required custom header, and no state changes on GET.
7. Rate limits are per key; a scalper uses many accounts and IPs, each under the limit. Add business rules: per-user and per-event seat caps in the transaction, verified accounts, hold-then-confirm with expiry, and alerts on unusual booking patterns (API6).
8. Make your server call internal services (Redis, Postgres, `localhost` admin ports), or the cloud metadata endpoint to steal credentials; or scan the internal network by timing. Defences: https and port 443 only; resolve and reject non-global IPs at save time and send time; no redirects; short timeouts and no echo of the response; ideally an egress proxy or network policy that blocks private ranges.
9. Defence in depth. The constraint turns any future bug (a code path that forgets the lock, a manual SQL fix, a race) into a failed transaction instead of an oversold event. It is enforced by the database regardless of which code path wrote the row.
10. pip-audit finds known, published vulnerabilities in third-party package versions. bandit finds risky patterns in your own source (string-built SQL, `shell=True`, `verify=False`, weak hashes). Neither finds authorization or business-logic flaws such as BOLA or seat hoarding; those need tests and review.
11. Treat it as compromised. Rotate it first (new value, deploy, revoke the old one), then check logs for misuse, then purge it from history if you wish, and add a pre-commit scanner so it does not recur. Deleting the commit alone does nothing for clones, forks and caches.
12. The client gets a generic `application/problem+json` body with status 500, a fixed title and an opaque `instance` error ID, with no traceback, SQL or exception message. The server logs the full exception, the request ID, route and user ID in a structured entry under the same error ID. Support can then find the log line from the ID the user reports.

## Sources

All pages below were opened while writing these notes. Code examples were run locally with Python 3.13, FastAPI 0.161.1, Starlette 1.7.0, Pydantic 2.13.5, SQLAlchemy 2.1.6, httpx 0.28.1, bandit 1.9.4 and pip-audit 2.10.1.

**OWASP API Security Top 10 (2023)**

- [OWASP Top 10 API Security Risks, 2023](https://api-security.owasp.org/editions/2023/en/0x11-t10/)
- [API3:2023 Broken Object Property Level Authorization](https://api-security.owasp.org/editions/2023/en/0xa3-broken-object-property-level-authorization/)
- [API4:2023 Unrestricted Resource Consumption](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/)
- [API6:2023 Unrestricted Access to Sensitive Business Flows](https://api-security.owasp.org/editions/2023/en/0xa6-unrestricted-access-to-sensitive-business-flows/)
- [API8:2023 Security Misconfiguration](https://api-security.owasp.org/editions/2023/en/0xa8-security-misconfiguration/)
- [API9:2023 Improper Inventory Management](https://api-security.owasp.org/editions/2023/en/0xa9-improper-inventory-management/)
- [API10:2023 Unsafe Consumption of APIs](https://api-security.owasp.org/editions/2023/en/0xaa-unsafe-consumption-of-apis/)

**OWASP Cheat Sheets**

- [REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)
- [Cross-Site Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [Server-Side Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)

**Framework and library docs**

- [FastAPI: CORS (Cross-Origin Resource Sharing)](https://fastapi.tiangolo.com/tutorial/cors/)
- [Starlette: Middleware](https://www.starlette.io/middleware/)
- [Uvicorn: Settings](https://www.uvicorn.org/settings/)
- [HTTPX: Timeouts](https://www.python-httpx.org/advanced/timeouts/)
- [Pydantic: Settings management](https://pydantic.dev/docs/validation/latest/concepts/pydantic_settings/)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)

**Tooling and CI**

- [pip-audit (PyPA)](https://github.com/pypa/pip-audit)
- [Bandit: Getting started](https://bandit.readthedocs.io/en/latest/start.html)
- [Gitleaks](https://github.com/gitleaks/gitleaks)
- [Gitleaks Action](https://github.com/gitleaks/gitleaks-action)
- [GitHub Docs: Dependabot options reference](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)
- [GitHub Docs: Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
