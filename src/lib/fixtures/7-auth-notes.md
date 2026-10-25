# Study Notes — Week 7: Authentication and Authorization

Oct 23, 2026 · @Mathew Matholomew

After this week you should be able to explain, from first principles, how a backend proves who a caller is and decides what that caller may touch. You will store passwords with Argon2id, issue 15-minute JWT access tokens with rotating refresh tokens, add "Sign in with GitHub" through OAuth 2.0, and enforce ownership so one user can never read or cancel another user's booking. Every example targets the event-booking capstone (FastAPI, PostgreSQL, Redis, Kafka).

## 1. Authentication vs authorization, and the threat model

**Authentication (authn)** answers "who is calling?". **Authorization (authz)** answers "is this caller allowed to do this action on this object?". They fail differently. A broken authn layer lets an attacker become someone else. A broken authz layer lets a legitimate, logged-in user reach data that is not theirs. In the capstone, a valid token for user 7 that can still `DELETE /bookings/913` (owned by user 12) is an authz bug, not an authn bug.

The moving parts:

- **Identity**: a stable internal subject, e.g. `users.id = 42`. Emails change; the subject should not. External identities (a GitHub account) link to this subject.
- **Credential**: something the client presents to prove identity. Passwords, TOTP codes, OAuth authorization codes, private keys.
- **Session**: the proof you hand back after a credential checks out, so the client does not resend the password on every request. It is either a random session ID that points at server state, or a self-contained signed token (a JWT).

Think of login as an exchange: an expensive, rare credential check turns into a cheap, frequent session check. Most auth design is about making that session artifact hard to steal, short-lived, and revocable.

### Threats you design against

| Threat | What the attacker does | Main defenses |
| --- | --- | --- |
| Credential stuffing | Replays email/password pairs leaked from other sites | Rate limiting per account and IP, breached-password checks, MFA |
| Brute force / spraying | Guesses many passwords for one user, or one common password across many users | Throttling, lockout with backoff, minimum length |
| Offline cracking | Steals your `users` table and guesses hashes on GPUs | Slow, salted, memory-hard hashing (Argon2id) |
| Token theft | Steals a bearer token from logs, browser storage, a proxy | Short TTLs, refresh rotation, never log tokens, HTTPS only |
| XSS | Runs JavaScript in your origin and reads anything JS can read | Output encoding, CSP, keep tokens out of `localStorage`, HttpOnly cookies |
| CSRF | Makes the victim's browser send a request that auto-attaches cookies | SameSite cookies, CSRF tokens, or bearer headers (not auto-attached) |
| User enumeration | Learns which emails are registered from error text, status codes or timing | Generic messages, uniform timing |

The XSS and CSRF rows explain most of the sessions-vs-tokens debate in section 3. Cookies are sent automatically, so they invite CSRF. Values readable by JavaScript can be exfiltrated by XSS. No storage choice is immune to XSS: an attacker running script in your page can always make requests as the user. The goal is to limit what they can carry away.

**Pitfalls**

- Treating "has a valid token" as "is allowed". Authn only gives you the subject; every handler still needs an authz decision.
- Using email as the primary key of identity. It breaks account linking and email changes.
- Assuming HTTPS solves token theft. Tokens also leak through logs, error trackers and browser extensions.

## 2. Password storage

Store passwords with Argon2id using a per-password random salt, and tune it so one verification costs tens of milliseconds and tens of MiB of RAM. Everything else in this section explains why.

### Why a fast hash is the wrong tool

SHA-256 is designed to be fast. A modern GPU computes billions of SHA-256 hashes per second. If your `users` table leaks, the attacker hashes a dictionary of likely passwords and compares. Speed helps them, not you. You verify a password once per login; they need to try billions of guesses. A **password hashing function** (also called a KDF in this context) makes each guess deliberately expensive so that asymmetry flips.

Three ingredients:

- **Salt**: a random value, unique per password, stored next to the hash. Two users with the password `qwerty123` get different hashes, and precomputed rainbow tables become useless. The attacker must attack each hash separately. Salts are not secret.
- **Work factor**: iterations (time cost) and memory cost. Raising them slows every guess linearly.
- **Memory hardness**: GPUs and ASICs have thousands of cores but little fast memory per core. Requiring, say, 19 MiB per guess caps how many guesses run in parallel. This is why Argon2id and scrypt beat PBKDF2 against hardware attackers.

A **pepper** is a secret shared by all hashes, kept outside the database (env var, secrets manager, HSM). If only the DB leaks, the hashes cannot be cracked without it. OWASP treats it as defense in depth. The usual form is post-hashing: store `HMAC(pepper, argon2_hash)`, or hash `HMAC(pepper, password)`. The cost: rotating a pepper forces password resets, so keep a pepper version column if you adopt one.

### Current OWASP parameters (checked October 2026)

The OWASP Password Storage Cheat Sheet lists equivalent Argon2id minimum configurations. Each trades memory for iterations; all use parallelism 1.

| Memory (m) | Iterations (t) | Parallelism (p) |
| --- | --- | --- |
| 47104 KiB (46 MiB) | 1 | 1 |
| 19456 KiB (19 MiB) | 2 | 1 |
| 12288 KiB (12 MiB) | 3 | 1 |
| 9216 KiB (9 MiB) | 4 | 1 |
| 7168 KiB (7 MiB) | 5 | 1 |

Fallbacks from the same page: scrypt with N=2^17, r=8, p=1; bcrypt with cost at least 10; PBKDF2-HMAC-SHA256 with 600,000 iterations (only when FIPS compliance forces it).

**bcrypt's 72-byte limit.** Most bcrypt implementations silently ignore everything past byte 72. Multibyte UTF-8 (Cyrillic or Kazakh letters are 2 bytes each) hits that limit sooner than you expect. Either enforce a 72-byte maximum or avoid bcrypt. Naive pre-hashing (`bcrypt(sha512(pw))`) is risky because raw digests can contain null bytes and it enables "password shucking". Argon2id has no such limit, which is one more reason to pick it.

### argon2-cffi in practice

`argon2-cffi` (25.1 at the time of writing) defaults to the RFC 9106 "low memory" profile: t=3, m=64 MiB, p=4. That is stronger than the OWASP minimum. On a small container where many logins run concurrently, 64 MiB per verify adds up, so pinning an OWASP row is reasonable. The encoded hash string carries the algorithm, version, parameters and salt, so you only store one column.

```python
# app/security/passwords.py
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

# OWASP row: 19 MiB, 2 iterations, 1 lane. Benchmark on your prod hardware.
_hasher = PasswordHasher(time_cost=2, memory_cost=19_456, parallelism=1)

# Used when the email is unknown, so both paths cost one Argon2 verify.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))


def hash_password(plain: str) -> str:
    return _hasher.hash(plain)  # '$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>'


def verify_password(stored_hash: str | None, plain: str) -> bool:
    """Constant-shape check: always runs exactly one Argon2 verify."""
    try:
        ok = _hasher.verify(stored_hash or _DUMMY_HASH, plain)
    except (VerificationError, InvalidHashError):  # VerifyMismatchError is a subclass
        return False
    return ok and stored_hash is not None


def needs_rehash(stored_hash: str) -> bool:
    return _hasher.check_needs_rehash(stored_hash)
```

`check_needs_rehash` compares the parameters encoded in a stored hash with the hasher's current ones. After a successful login you have the plaintext in memory, so that is the only moment you can upgrade the hash transparently:

```python
async def authenticate(repo: UserRepo, email: str, password: str) -> User | None:
    user = await repo.get_by_email(email.strip().lower())
    if not verify_password(user.password_hash if user else None, password):
        return None
    if user and needs_rehash(user.password_hash):
        await repo.set_password_hash(user.id, hash_password(password))
    return user
```

### Timing-safe comparisons and enumeration

A normal `==` on strings can return as soon as the first byte differs. Over many requests that leaks how much of a secret matched. Argon2's `verify` already compares in constant time. For anything else you compare yourself (API keys, reset-token digests, HMACs), use `hmac.compare_digest(a, b)` or `secrets.compare_digest`.

The bigger timing leak is structural. If an unknown email returns in 2 ms and a known email with a wrong password returns in 60 ms (one Argon2 verify), anyone can enumerate accounts with a stopwatch. The dummy-hash trick above makes both paths do the same work. FastAPI's own JWT tutorial now uses exactly this pattern. The login response must also be identical in status code and body for "no such user", "wrong password" and "account disabled":

```http
POST /auth/login HTTP/1.1
Content-Type: application/x-www-form-urlencoded

username=aigerim%40example.kz&password=wrong-guess

HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
Content-Type: application/json

{"detail": "Incorrect email or password"}
```

Registration is the other enumeration channel. "Email already registered" tells an attacker the account exists. Stricter apps return the same "check your inbox" response either way and send a "someone tried to register with your email" mail to existing users. For the capstone, a 409 is acceptable if you rate limit `/auth/register`, but know the trade-off.

**Pitfalls**

- Hashing on the event loop. Argon2 is CPU-bound and blocks for tens of ms. In async FastAPI handlers, run it via `await anyio.to_thread.run_sync(...)` or a sync `def` dependency.
- Passing your own salt to `hash()`. Let the library generate it.
- No maximum length. Accepting a 1 MB password is a cheap DoS on a memory-hard hash; cap at something like 128 to 256 characters (and at least 64).
- Comparing tokens or HMACs with `==`.
- Copying the CHEAPEST profile from tests into production settings.

## 3. Sessions vs tokens

Both approaches hand the client an artifact after login. The difference is where the truth lives. A **server-side session** gives the client a random, meaningless ID; the server looks it up on every request (Redis, Postgres). A **self-contained token** (JWT) carries the claims itself, signed, so any service holding the key can verify it with no lookup.

### Server-side sessions with cookies

Login creates a row `session_id -> {user_id, created_at, ...}` in Redis with a TTL and sets a cookie:

```http
HTTP/1.1 204 No Content
Set-Cookie: sid=Jx0f...q8; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1209600
```

The cookie attributes do the security work:

- **HttpOnly**: JavaScript cannot read the cookie, so an XSS payload cannot exfiltrate it (it can still ride the session while the page is open).
- **Secure**: sent only over HTTPS.
- **SameSite=Lax**: the browser omits the cookie on most cross-site subrequests (forms posted from evil.com, fetches, iframes), but sends it on top-level GET navigations. `Strict` also drops it on cross-site navigation. `None` sends it everywhere and requires `Secure`. Lax blocks most CSRF but not all; state-changing GETs or same-site subdomains you do not control remain risks, so add a CSRF token for sensitive forms.
- **`__Host-` prefix** (e.g. `__Host-sid`): forces Secure, Path=/ and no Domain, so a sibling subdomain cannot overwrite it.

Revocation is trivial: delete the Redis key. "Log out everywhere" is deleting all keys for a user.

### Bearer tokens

The client sends `Authorization: Bearer <jwt>` explicitly. The browser never attaches it on its own, so classic CSRF does not apply. The cost moves elsewhere: the client code must store the token somewhere JavaScript can reach (memory, `localStorage`), which XSS can read. And because verification needs no lookup, you cannot revoke a JWT before `exp` without reintroducing state (a denylist, section 5).

| Concern | Server-side session + cookie | Bearer JWT |
| --- | --- | --- |
| Revocation | Immediate: delete the record | Hard: wait for `exp` or check a denylist |
| Per-request cost | One store lookup (Redis \~sub-ms) | Signature check, no I/O |
| Horizontal scaling | Needs a shared store | Any instance with the key verifies |
| Many services | Each needs access to the store | Verify with a public key (JWKS) |
| CSRF exposure | Yes (auto-sent); mitigate with SameSite + tokens | No (header is explicit) |
| XSS exposure | Cookie unreadable with HttpOnly | Token readable if stored in JS-accessible storage |
| Mobile / CLI clients | Awkward: cookie jars | Natural: store in Keychain/Keystore, send header |
| Size | Tiny ID | Grows with claims, sent on every request |
| Server state | Yes | None for access tokens (refresh tokens still need state) |

### When each fits

- **Browser app on the same site as the API** (server-rendered, or an SPA on `app.example.kz` calling `api.example.kz`): cookie sessions are simpler and safer. Many teams use a backend-for-frontend (BFF) that holds tokens server-side and gives the browser only a session cookie.
- **Mobile apps, CLIs, third-party clients, service-to-service**: bearer tokens.
- **Many independently deployed services** that should not all call an auth DB: JWT access tokens verified with a public key, plus a stateful refresh token at the auth service.

The capstone is an API consumed by any client and tested with httpx, so this week uses bearer JWT access tokens plus stateful refresh tokens. That hybrid is the common real-world answer: stateless where it is cheap, stateful where revocation matters.

**Pitfalls**

- Believing JWTs are "more secure" than sessions. They are a scaling and distribution choice, not a security upgrade.
- Putting JWTs in a cookie and then forgetting that cookies bring CSRF back.
- Storing long-lived refresh tokens in `localStorage` in a browser. If you must serve browsers with tokens, keep the refresh token in an HttpOnly cookie scoped to `Path=/auth/refresh`.
- Using sessions without rotating the session ID at login (session fixation).

## 4. JWT in depth

A JWT is a signed, base64url-encoded JSON document. Signed is not encrypted: anyone holding the token can read every claim. The signature only proves that the issuer produced it and nobody changed it.

### Structure

Three base64url segments joined by dots: `header.payload.signature`.

```python
# header (decoded)
{"alg": "EdDSA", "typ": "JWT", "kid": "2026-10"}

# payload (decoded)
{
    "iss": "https://api.booking.local",
    "sub": "42",
    "aud": "booking-api",
    "iat": 1792771200,
    "nbf": 1792771200,
    "exp": 1792772100,
    "jti": "5b0c7c7e-8f4e-4b55-9a51-2a2f3c4f0d11",
    "role": "user",
    "scope": "bookings:read bookings:write"
}
```

The signature is computed over the exact bytes `base64url(header) + "." + base64url(payload)`. Change one character and verification fails.

### Registered claims (RFC 7519)

| Claim | Meaning | How you use it in the capstone |
| --- | --- | --- |
| `iss` | Who issued it | Your API URL; reject others |
| `sub` | Who it is about | `str(user.id)`. PyJWT 2.10+ rejects a non-string `sub` |
| `aud` | Who should accept it | `"booking-api"`; stops a token minted for another service being replayed here |
| `exp` | Reject at or after this time | `iat + 15 min` for access tokens |
| `nbf` | Reject before this time | Usually equal to `iat` |
| `iat` | When issued | Debugging; "tokens issued before password change are invalid" checks |
| `jti` | Unique token ID | Key for the Redis denylist and refresh-token records |

Times are seconds since the epoch (NumericDate). Custom claims such as `role` or `scope` are fine, but keep the token small and never put secrets or PII you would not show the user in it.

### Algorithms and key distribution

- **HS256** (HMAC-SHA256): one shared secret both signs and verifies. Fast and simple. But every verifier can also mint tokens. Fine when one service issues and verifies. The secret must be random, at least 32 bytes (`secrets.token_urlsafe(64)`); PyJWT warns on shorter keys.
- **RS256** (RSA) and **ES256** (ECDSA P-256): asymmetric. The auth service signs with a private key; any service verifies with the public key and cannot forge.
- **EdDSA** (Ed25519): asymmetric, small keys, fast, deterministic signatures (no nonce bugs like ECDSA). A good default for new systems if every consumer supports it.

With asymmetric keys, verifiers fetch public keys from a **JWKS** endpoint (`/.well-known/jwks.json`), a JSON list of keys each tagged with a `kid`. The token header names the `kid` it was signed with. Rotation becomes: publish the new key, start signing with it, keep the old key in the JWKS until all old tokens expire, then drop it. PyJWT's `PyJWKClient(url).get_signing_key_from_jwt(token)` does the lookup and caching.

### Validation checklist

Every decode must do all of these. Missing one is a real vulnerability.

1. **Pin the algorithm list** in code: `algorithms=["EdDSA"]`. Never derive it from the token header.
2. **Verify the signature** with the right key for that algorithm (resolved by an allow-listed `kid`).
3. **Check `exp` and `nbf`** with a small leeway (RFC 7519 suggests a few minutes at most; 30 to 60 s is plenty inside one cluster).
4. **Check `aud`** equals your service and **`iss`** equals your issuer.
5. **Require the claims** you rely on (`sub`, `exp`, `jti`) so a token without them fails instead of defaulting.
6. **Check token type**: an access token must not be accepted where a refresh token is expected and vice versa. Use a `typ` header or a `token_use` claim, or separate keys/audiences.
7. **Then** check application state: user still exists and is active, `jti` not revoked.

### Attacks you must know

- **`alg: none`**: the attacker strips the signature and sets `alg` to `none`. Libraries that trusted the header accepted it. Fix: an explicit algorithm allow-list. PyJWT raises `InvalidAlgorithmError` when `none` is not in `algorithms`.
- **Algorithm confusion (RS256 to HS256)**: the server verifies with `key=public_key_pem` and lets the header choose the algorithm. The attacker signs with HS256 using the public key bytes as the HMAC secret, and a naive library verifies it. Fix: pin one algorithm family per key. PyJWT also refuses to use a PEM public key as an HMAC secret.
- **Weak HMAC secrets**: HS256 tokens can be brute-forced offline from a single captured token. `secret`, `changeme` or a 10-character password fall in minutes with hashcat.
- **`kid` injection**: if `kid` is used as a file path or inside a SQL query to load a key, it becomes path traversal or SQL injection. Treat `kid` as an opaque lookup key into a fixed dict of known keys. Likewise, never fetch keys from a URL in the token's `jku`/`x5u` header.
- **Missing `aud`**: a token issued for your notifications service gets replayed against the booking API.

### PyJWT, verified

This snippet ran against PyJWT 2.15 (the docs currently show 2.15.1). Note that `encode` returns `str` in PyJWT 2.x.

```python
# app/security/tokens.py
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt

ISSUER = "https://api.booking.local"
AUDIENCE = "booking-api"
ALGORITHM = "HS256"          # switch to "EdDSA" with pyjwt[crypto] keys later
ACCESS_TTL = timedelta(minutes=15)


def create_access_token(user_id: int, role: str, scopes: list[str], secret: str) -> str:
    now = datetime.now(UTC)
    claims: dict[str, Any] = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "sub": str(user_id),           # must be a string
        "iat": now,                    # PyJWT converts datetimes to NumericDate
        "nbf": now,
        "exp": now + ACCESS_TTL,
        "jti": str(uuid.uuid4()),
        "role": role,
        "scope": " ".join(scopes),
    }
    return jwt.encode(claims, secret, algorithm=ALGORITHM, headers={"typ": "at+jwt"})


def decode_access_token(token: str, secret: str) -> dict[str, Any]:
    if jwt.get_unverified_header(token).get("typ") != "at+jwt":
        raise jwt.InvalidTokenError("wrong token type")
    return jwt.decode(
        token,
        secret,
        algorithms=[ALGORITHM],        # allow-list, never from the header
        audience=AUDIENCE,
        issuer=ISSUER,
        leeway=30,
        options={"require": ["exp", "iat", "sub", "aud", "iss", "jti"]},
    )
```

Reading the header before verification is acceptable only for routing decisions (token type, `kid` lookup); the claims are trusted only after `jwt.decode` succeeds. The exceptions you will map to 401 all inherit from `jwt.InvalidTokenError`: `ExpiredSignatureError`, `InvalidAudienceError`, `InvalidIssuerError`, `MissingRequiredClaimError`, `InvalidSignatureError`.

For asymmetric verification across services:

```python
from jwt import PyJWKClient

jwks = PyJWKClient("https://auth.booking.local/.well-known/jwks.json")

def decode_from_auth_service(token: str) -> dict[str, Any]:
    key = jwks.get_signing_key_from_jwt(token)   # picks by kid, caches
    return jwt.decode(token, key, algorithms=["EdDSA"], audience=AUDIENCE, issuer=ISSUER)
```

**Pitfalls**

- `options={"verify_signature": False}` left in from debugging.
- Using `jwt.decode` without `audience` when the token has an `aud` claim (PyJWT raises), then "fixing" it by disabling the check.
- Long-lived access tokens (24 h, 30 days) because refresh felt like extra work.
- Treating claims like `role` as authoritative forever. A demoted admin keeps admin rights until `exp`; keep TTLs short or re-check the DB for sensitive actions.
- Using `datetime.utcnow()` (naive, deprecated in 3.12). Use `datetime.now(UTC)`.

## 5. Access tokens, refresh tokens, rotation and revocation

Split the session into two artifacts with different jobs. The **access token** is short-lived (15 minutes), stateless and sent on every API call. The **refresh token** is long-lived (days), stateful, sent only to `/auth/refresh`, and exchanged for a new pair. A stolen access token is useful for minutes. A stolen refresh token is the real prize, so it gets the heavy protection.

### Why rotation

Without rotation, a refresh token is a 14-day password the attacker can reuse silently. With **rotation**, every successful refresh invalidates the presented token and issues a new one. Each refresh token is therefore single-use. RFC 9700 (OAuth 2.0 Security BCP, January 2025) requires refresh tokens for public clients to be either sender-constrained or rotated.

Rotation alone does not tell you who is the attacker. **Reuse detection** does. All refresh tokens descended from one login form a **family**. If a token that was already rotated shows up again, either the legitimate client or the attacker is replaying it. You cannot tell which, so you revoke the whole family, including the newest token. Both parties lose access; the real user logs in again with their password, the attacker cannot.

The diagram below walks through a theft. The key insight: the legitimate client keeps using its tokens, so a thief's copy always collides with it eventually.

&#91;embedded content: refresh rotation with reuse detection · one stolen token\]

If the real client had refreshed first instead, the attacker's later replay of R1 would trip the same check. Either order ends with the family revoked.

### Storage design for the capstone

Two options, both valid:

| Option | Refresh token is | Server stores | Pros | Cons |
| --- | --- | --- | --- | --- |
| Opaque | 32+ random bytes (`secrets.token_urlsafe(32)`) | `sha256(token)`, `user_id`, `family_id`, `expires_at`, `used_at` in Postgres | Nothing to decode; easy audit trail and "list my devices" | DB write on every refresh |
| JWT + Redis | Signed JWT with `jti`, `fam`, `typ=refresh` | Used `jti`s and revoked families as Redis keys with TTL | Matches access-token code; Redis TTL cleans up | Lose Redis, lose revocation state (enable AOF) |

Store only a hash of an opaque refresh token. If the table leaks, hashes are useless to the attacker. A fast SHA-256 is fine here (unlike passwords), because the token is high-entropy random data that cannot be guessed.

The Build task asks for revoked IDs in Redis with TTL, so the sketch below uses the JWT + Redis design. The atomic trick: `SET key value NX EX ttl` succeeds only for the first caller. Marking a `jti` as used and detecting reuse become one race-free operation.

```python
# app/auth/refresh.py
import uuid
from datetime import UTC, datetime

from redis.asyncio import Redis


class RefreshReused(Exception): ...
class RefreshRevoked(Exception): ...


async def rotate_refresh(redis: Redis, claims: dict) -> tuple[str, str]:
    """claims = already-verified refresh JWT (typ=refresh). Returns (access, refresh)."""
    jti, fam, exp = claims["jti"], claims["fam"], claims["exp"]
    ttl = max(int(exp - datetime.now(UTC).timestamp()), 1)

    if await redis.exists(f"rt:fam:revoked:{fam}"):
        raise RefreshRevoked

    first_use = await redis.set(f"rt:used:{jti}", "1", nx=True, ex=ttl)
    if not first_use:
        # Replay of a rotated token: kill the whole family until its max lifetime.
        await redis.set(f"rt:fam:revoked:{fam}", "reuse", ex=REFRESH_MAX_TTL)
        # emit an audit event / alert here
        raise RefreshReused

    user_id = int(claims["sub"])
    new_refresh = create_refresh_token(user_id, family=fam, jti=str(uuid.uuid4()))
    new_access = create_access_token(user_id, ...)
    return new_access, new_refresh
```

Both exceptions become `401` with the same generic body. Do not tell the client "reuse detected"; log it server-side instead.

### Revoking access tokens: the jti denylist

Access tokens are stateless, so revoking one early needs state again. Keep it small: a Redis key per revoked `jti` that expires exactly when the token would have expired anyway. The denylist never grows beyond 15 minutes of logouts.

```python
async def revoke_access(redis: Redis, claims: dict) -> None:
    ttl = int(claims["exp"] - datetime.now(UTC).timestamp())
    if ttl > 0:
        await redis.set(f"at:revoked:{claims['jti']}", "1", ex=ttl)


async def is_access_revoked(redis: Redis, jti: str) -> bool:
    return bool(await redis.exists(f"at:revoked:{jti}"))
```

This adds one Redis round trip per request. Many teams accept it. Others skip the access denylist and rely on the 15-minute TTL, revoking only refresh families. Know which one you chose and why.

### Logout semantics

- **Logout this device**: deny the current access `jti`, revoke the refresh family (or mark the current refresh token used).
- **Logout everywhere**: store `tokens_valid_after = now()` on the user (Postgres or `user:{id}:tva` in Redis) and reject any token whose `iat` is older. One key revokes every family and access token for that user. Use it after password change or reset too.
- **Client side**: drop both tokens. Never rely on the client alone; it may be the attacker.

```http
POST /auth/refresh HTTP/1.1
Content-Type: application/json

{"refresh_token": "eyJhbGciOi...old"}

HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json

{"access_token": "eyJ...", "refresh_token": "eyJ...new", "token_type": "bearer", "expires_in": 900}
```

**Pitfalls**

- Accepting a refresh token as an access token (or the reverse). Check `typ` on both paths.
- Non-atomic "check then mark used". Two parallel requests both pass the check. Use `SET NX` or a DB row lock / `UPDATE ... WHERE used_at IS NULL RETURNING`.
- Legitimate races: an SPA with two tabs refreshing at once will trip reuse detection. Either serialize refresh on the client or allow a few seconds of grace where the previous token returns the same new pair.
- Sliding refresh forever. Cap the family's absolute lifetime (e.g. 30 days) regardless of rotation.
- Forgetting `Cache-Control: no-store` on token responses.

## 6. FastAPI implementation

FastAPI's security tools are thin. `OAuth2PasswordBearer` and `HTTPBearer` only extract the token from the `Authorization` header and document the scheme in OpenAPI (which powers the Authorize button in `/docs`). Verification, user loading and permissions are your dependencies. That is a good thing: auth becomes ordinary, testable dependency injection.

A note on libraries: FastAPI's current JWT tutorial uses **PyJWT** and **pwdlib** (with Argon2), and mentions passlib only for reading old hashes. Older blog posts with `python-jose` and `passlib` are outdated. This doc uses argon2-cffi directly, which is what pwdlib's Argon2 backend wraps.

### Extracting the token

| Class | What it does | When to use |
| --- | --- | --- |
| `OAuth2PasswordBearer(tokenUrl="/auth/login", scopes={...})` | Reads `Bearer` header; OpenAPI shows a username/password login form posting to `tokenUrl` | Password login with a form; you want `/docs` to log in for you |
| `HTTPBearer(auto_error=False)` | Reads `Bearer` header; OpenAPI shows a paste-a-token box | Tokens come from elsewhere (GitHub login, another service) |

Both raise their own error when the header is missing unless you pass `auto_error=False`. Turning it off lets you control the exact 401 body and header.

### The current\_user dependency chain

```python
# app/auth/deps.py
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Security, status
from fastapi.security import OAuth2PasswordBearer, SecurityScopes

oauth2_scheme = OAuth2PasswordBearer(
    tokenUrl="/auth/login",
    scopes={
        "bookings:read": "Read your bookings",
        "bookings:write": "Create and cancel your bookings",
        "events:admin": "Create and edit events",
    },
    auto_error=False,
)


def _unauthorized(scopes: SecurityScopes, error: str | None = None) -> HTTPException:
    value = "Bearer"
    if error:
        value += f' error="{error}"'
    if scopes.scopes:
        value += f' scope="{scopes.scope_str}"'
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": value},
    )


async def get_current_user(
    security_scopes: SecurityScopes,
    token: Annotated[str | None, Depends(oauth2_scheme)],
    settings: SettingsDep,
    redis: RedisDep,
    users: UserRepoDep,
) -> User:
    if token is None:
        raise _unauthorized(security_scopes)              # no error code when no token
    try:
        claims = decode_access_token(token, settings.jwt_secret)
    except jwt.InvalidTokenError:
        raise _unauthorized(security_scopes, "invalid_token")
    if await is_access_revoked(redis, claims["jti"]):
        raise _unauthorized(security_scopes, "invalid_token")

    user = await users.get(int(claims["sub"]))
    if user is None or not user.is_active:
        raise _unauthorized(security_scopes, "invalid_token")

    granted = set(claims.get("scope", "").split())
    missing = set(security_scopes.scopes) - granted
    if missing:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient scope",
            headers={"WWW-Authenticate": f'Bearer error="insufficient_scope" scope="{security_scopes.scope_str}"'},
        )
    return user


CurrentUser = Annotated[User, Security(get_current_user)]
```

`Security` is a subclass of `Depends` that adds a `scopes` list. FastAPI collects the scopes required anywhere in the dependency tree and hands them to `get_current_user` through `SecurityScopes`. So one dependency enforces whatever each route asks for:

```python
@router.get("/users/me/bookings")
async def my_bookings(
    user: Annotated[User, Security(get_current_user, scopes=["bookings:read"])],
    service: BookingServiceDep,
) -> list[BookingOut]:
    return await service.list_for_user(user.id)
```

### 401 vs 403

The rule from RFC 6750 (Bearer tokens):

- **401 Unauthorized** means "I do not know who you are": missing, malformed, expired or revoked token. Must carry `WWW-Authenticate: Bearer`, with `error="invalid_token"` when a token was sent and failed. The client should refresh or log in again.
- **403 Forbidden** means "I know who you are, and the answer is no": valid token, insufficient scope or role, or not the owner. Refreshing will not help.
- Some APIs return **404** instead of 403 for objects the caller does not own, so existence is not leaked. Pick one policy and apply it consistently; the Build tests in this plan expect 403.

FastAPI's tutorial raises 401 for missing scopes. RFC 6750 maps `insufficient_scope` to 403, which is what this doc uses.

```http
GET /users/me/bookings HTTP/1.1
Authorization: Bearer eyJ...expired

HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token" scope="bookings:read"
Content-Type: application/json

{"detail": "Not authenticated"}
```

### Testing auth with dependency overrides

You do not need real tokens in most handler tests. Override the dependency:

```python
app.dependency_overrides[get_current_user] = lambda: User(id=7, role="user", is_active=True)
```

Keep a separate, small test module that exercises the real chain (no override) with real tokens, expired tokens and wrong audiences. That is where the Build task's "401 with no/expired token" tests live.

**Pitfalls**

- Calling `jwt.decode` inside each route. Put it in one dependency so no route forgets a check.
- Returning 403 for a missing token, or 401 for a valid token lacking permission. Clients use the status to decide whether to refresh.
- Letting `OAuth2PasswordRequestForm.scopes` grant whatever the client asks for. Intersect requested scopes with what the user's role allows.
- Forgetting that `async def` dependencies running Argon2 block the loop (see section 2).

## 7. OAuth 2.0 and OpenID Connect

OAuth 2.0 (RFC 6749) is a **delegation** protocol: it lets a user grant an application limited access to their resources at another service without handing over their password. OpenID Connect (OIDC) is a thin identity layer on top that adds a signed **ID token** saying who logged in. "Sign in with GitHub" uses OAuth to borrow GitHub's authentication for your app.

### Four roles

| Role | In "Sign in with GitHub" for the capstone |
| --- | --- |
| Resource owner | The person with the GitHub account |
| Client | Your booking API backend (a confidential client: it can keep a `client_secret`) |
| Authorization server | `github.com/login/oauth/*`: authenticates the user, asks for consent, issues codes and tokens |
| Resource server | `api.github.com`: accepts GitHub's access token, returns the profile and emails |

Note the twist: your API is the *client* here. Once you know who the user is, you mint your own tokens (section 5) and GitHub drops out of the picture.

### Authorization code flow with PKCE, step by step

1. The client generates a random `state` and a random `code_verifier` (43 to 128 chars), then computes `code_challenge = BASE64URL(SHA256(code_verifier))`. Both are saved server-side (in the session).
2. The browser is redirected to the authorization endpoint with `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`.
3. The user logs in at GitHub and approves the scopes. Your app never sees the password.
4. GitHub redirects back to `redirect_uri?code=...&state=...`. The code is short-lived and single-use.
5. The client checks `state` matches what it stored. A mismatch means a forged callback (login CSRF): abort.
6. The client POSTs to the token endpoint, server to server: `code`, `redirect_uri`, `client_id`, `client_secret`, and the original `code_verifier`.
7. The authorization server hashes the verifier, compares it with the stored challenge, and only then returns the access token (plus an ID token for OIDC providers).
8. The client calls the resource server (`GET /user`) with the access token, finds or creates the local user, and issues its own session.

&#91;embedded content: authorization code + PKCE · Sign in with GitHub, 14 steps\]

The verifier travels only on the server-to-server POST in step 9; everything the browser sees (steps 3 to 7) is useless to an interceptor without it.

Why PKCE when there is already a client secret? An attacker who intercepts the authorization code (malicious app on a phone, leaked logs, a referrer header) cannot redeem it without the verifier, which never left your server. RFC 9700 requires PKCE for public clients and recommends it for confidential ones; GitHub supports only `S256`.

### state and nonce

- **state** binds the callback to the browser session that started the flow. It defeats login CSRF, where an attacker tricks you into finishing *their* login so your actions land in their account.
- **nonce** (OIDC only) goes into the authorization request and comes back inside the signed ID token. It binds the ID token to this login attempt, which stops replay of an old ID token.

PKCE overlaps with state for CSRF protection, but keep both: they cost nothing and some providers still lack PKCE.

### Scopes, ID tokens and access tokens

Scopes are the permissions requested (`read:user user:email` for GitHub, `openid email profile` for Google). Ask for the minimum.

|  | ID token (OIDC) | Access token |
| --- | --- | --- |
| Audience | Your app (the client) | The resource server (API) |
| Format | Always a JWT | Opaque string or JWT, provider's choice |
| Purpose | Prove who logged in, when, how | Authorize API calls |
| You should | Validate signature, `iss`, `aud`, `exp`, `nonce`; read `sub`, `email` | Send it to the provider's API; never parse it |
| Never | Send it to an API as a bearer token | Treat it as proof of identity |

Google is a full OIDC provider, so Authlib can validate its ID token automatically. GitHub is plain OAuth 2.0 for OAuth Apps: there is no ID token, and you learn identity by calling `GET https://api.github.com/user` with the access token.

### Why implicit and ROPC are gone

- **Implicit grant** returned the access token directly in the redirect URL fragment. It leaked through browser history and referrers, and there was no way to sender-constrain it. Browser apps now use code + PKCE.
- **Resource Owner Password Credentials (ROPC)** had the client collect the user's password and send it to the authorization server. It trains users to type passwords into third parties and cannot support MFA or federated login. RFC 9700 says it must not be used.
- **OAuth 2.1** consolidates these lessons: authorization code (with PKCE required), client credentials and refresh token, and drops implicit and ROPC. As of October 2026 it is still an Internet-Draft (draft-ietf-oauth-v2-1-16, September 2026), not an RFC. Cite RFC 9700 for normative guidance today.

The FastAPI tutorial's `/token` endpoint looks like ROPC because it uses `OAuth2PasswordRequestForm`. That is acceptable when the client is your own first-party app talking to your own auth server; the warning is about third parties.

### Sign in with GitHub using Authlib

Authlib's Starlette client works with FastAPI unchanged. It stores `state`, the PKCE verifier and (for OIDC) the nonce in the Starlette session, so you need `SessionMiddleware` (cookie-backed, needs `itsdangerous`). Verified against Authlib 1.9.

```python
# app/auth/github.py
from authlib.integrations.starlette_client import OAuth, OAuthError
from fastapi import APIRouter, HTTPException, Request
from starlette.middleware.sessions import SessionMiddleware

oauth = OAuth()
oauth.register(
    name="github",
    client_id=settings.github_client_id,
    client_secret=settings.github_client_secret,
    authorize_url="https://github.com/login/oauth/authorize",
    access_token_url="https://github.com/login/oauth/access_token",
    api_base_url="https://api.github.com/",
    client_kwargs={"scope": "read:user user:email", "code_challenge_method": "S256"},
)

router = APIRouter(prefix="/auth/github")


@router.get("/login")
async def github_login(request: Request):
    redirect_uri = request.url_for("github_callback")   # must match the app's registered URL
    return await oauth.github.authorize_redirect(request, redirect_uri)


@router.get("/callback", name="github_callback")
async def github_callback(request: Request, identities: IdentityServiceDep) -> TokenPair:
    try:
        token = await oauth.github.authorize_access_token(request)  # checks state, sends verifier
    except OAuthError:
        raise HTTPException(status_code=400, detail="GitHub login failed")
    profile = (await oauth.github.get("user", token=token)).json()
    emails = (await oauth.github.get("user/emails", token=token)).json()
    user = await identities.link_or_create("github", str(profile["id"]), emails)
    return issue_token_pair(user)   # your own access + refresh tokens

# main.py
app.add_middleware(SessionMiddleware, secret_key=settings.session_secret, https_only=True)
```

For Google, register with `server_metadata_url="https://accounts.google.com/.well-known/openid-configuration"` and `scope="openid email profile"`; after `authorize_access_token`, the validated claims are in `token["userinfo"]`.

### Linking external identities to local users

Keep identities in their own table, keyed by the provider's stable ID, never by email or username (GitHub logins can be renamed):

```python
class ExternalIdentity(Base):
    __tablename__ = "external_identities"
    provider: Mapped[str] = mapped_column(primary_key=True)          # "github"
    provider_user_id: Mapped[str] = mapped_column(primary_key=True)  # str(profile["id"])
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    linked_at: Mapped[datetime] = mapped_column(server_default=func.now())
```

Link logic:

1. Identity row exists: log in that `user_id`.
2. No row, user is already logged in (a "connect GitHub" button): attach to the current user.
3. No row, anonymous: create a new user (with `password_hash = NULL`) and the identity row.
4. Auto-linking to an existing local account by email is dangerous. Do it only with a **verified** primary email from the provider (GitHub's `/user/emails` reports `verified`), otherwise an attacker who registers an unverified email at the provider takes over the local account. Safer: ask the user to log in with their password first, then link.

**Pitfalls**

- Skipping the `state` check, or storing state in a place an attacker can set.
- Building `redirect_uri` from the `Host` header behind a proxy. Configure the external URL; providers match redirect URIs exactly.
- Using the provider's access token as your API's session token. Mint your own.
- Requesting broad scopes (`repo`) for login. You need identity, not code access.
- Trusting an ID token without checking `aud` equals your `client_id`.

## 8. Authorization models

Authorization is a function `allowed(subject, action, resource, context) -> bool`. The models below differ in which inputs they look at. Real systems combine them: a role check gates the endpoint, then an ownership check gates the specific row.

| Model | Decision based on | Capstone example | Weak spot |
| --- | --- | --- | --- |
| RBAC (roles) | The subject's role(s) | Only `admin` may `POST /events` | Coarse: "user" role says nothing about *which* bookings |
| Scopes | What this token was granted | A token with only `bookings:read` cannot cancel | Limits the token, not the user; not a substitute for ownership |
| ABAC (attributes) | Attributes of subject, resource, environment | Cancel allowed only if `booking.user_id == user.id` and `event.starts_at > now + 24h` | Rules spread out; needs discipline or a policy engine |
| Object-level / ownership | Relationship between subject and the specific object | User 7 can read booking 913 only if they own it | Easy to forget on one endpoint |

Scopes and roles answer different questions. A role is what the *user* may do. A scope is what this *token* may do, which can be less (a read-only token for a reporting script). Effective permission is the intersection.

### BOLA: the top API risk

Broken Object Level Authorization (BOLA, also called IDOR) is number one in the OWASP API Security Top 10 (2023). The attack is trivial: log in as yourself, then change the ID in the URL.

```http
GET /bookings/913 HTTP/1.1
Authorization: Bearer <valid token for user 7>
```

If the handler does `SELECT * FROM bookings WHERE id = 913`, user 7 reads user 12's booking. Authentication worked perfectly. Sequential integer IDs make it worse, but UUIDs are not a fix: they leak in URLs, logs and shared links. The sibling doc on OWASP API Top 10 covers the wider list; here the focus is enforcement.

### Enforce ownership where the data is fetched

The robust pattern is to make it impossible to load a booking without saying whose it is. Push the `user_id` into the query itself, in the repository:

```python
# app/bookings/repository.py
class BookingRepo:
    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def get_owned(self, booking_id: int, owner_id: int) -> Booking | None:
        stmt = select(Booking).where(Booking.id == booking_id, Booking.user_id == owner_id)
        return await self._s.scalar(stmt)

    async def list_owned(self, owner_id: int, *, limit: int = 50) -> list[Booking]:
        stmt = (
            select(Booking)
            .where(Booking.user_id == owner_id)
            .order_by(Booking.created_at.desc())
            .limit(limit)
        )
        return list(await self._s.scalars(stmt))
```

```python
# app/bookings/service.py
class BookingService:
    async def cancel(self, actor: User, booking_id: int) -> Booking:
        booking = await self.repo.get_owned(booking_id, owner_id=actor.id)
        if booking is None:
            # Decide once: 404 hides existence; 403 is what this week's tests expect.
            if await self.repo.exists(booking_id):
                raise Forbidden("Not your booking")
            raise NotFound("Booking not found")
        ...  # release the seat, update status, publish booking.cancelled
```

Why the service/repository layer and not only the route?

- **Every path is covered.** The Kafka worker, an admin CLI, a future GraphQL layer all go through the same service. A check in one route protects one route.
- **The secure call is the easy call.** If `get_owned` is the only public getter, a developer cannot forget the filter. An unscoped `get_by_id` should be named loudly (`get_any_for_admin`) and used rarely.
- **One query, no race.** Checking ownership after fetching is fine; fetching with the filter is cheaper and leaves nothing to forget.

The `/users/{user_id}/bookings` URL is itself a BOLA invitation: the client chooses whose data to read. Replace it with `/users/me/bookings`, where the identity comes only from the token.

### Admin-only endpoints

A small dependency factory keeps role checks declarative:

```python
def require_role(*roles: str):
    async def checker(user: CurrentUser) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail="Forbidden")
        return user
    return checker

AdminUser = Annotated[User, Depends(require_role("admin"))]

@router.post("/events", status_code=201)
async def create_event(payload: EventIn, admin: AdminUser, svc: EventServiceDep) -> EventOut:
    return await svc.create(payload, created_by=admin.id)
```

Read the role from the database (the `user` returned by `get_current_user`), not only from the token claim, so a demotion takes effect immediately. If you put `role` in the JWT for other services, accept the up-to-15-minute staleness consciously.

**Pitfalls**

- Authorization only in the frontend (hiding the button). The API is the boundary.
- Checking ownership on GET but not on PATCH/DELETE, or on the parent but not the child (`/events/5/bookings/913` where 913 belongs to event 6).
- Taking `user_id` from the request body on create (`POST /bookings {"user_id": 12}`). Set it from the token.
- Mass assignment: letting `role` or `is_admin` arrive in a profile update payload.
- Returning 403 with a body that reveals the owner.

## 9. Hardening auth endpoints

Login, refresh, register and password reset are the endpoints attackers hit hardest, because each successful guess yields a whole account. Four controls cover most of the risk.

### Rate limiting and lockout on /auth/login

Limit on two keys at once:

- **Per account** (normalized email): stops brute force against one user, even when the attacker rotates IPs. OWASP ties the failure counter to the account, not the source.
- **Per IP**: stops one machine spraying many accounts (credential stuffing).

Prefer throttling with backoff over hard lockout. A hard lockout after 5 failures lets anyone lock any user out by typing their email five times (a DoS). Backoff or a temporary 15-minute block, plus a still-working password reset, is the usual compromise. Count failures only; reset the account counter on success.

Reuse the Redis limiter from your earlier week. A fixed-window failure counter is enough here:

```python
# app/auth/limits.py
async def check_login_allowed(redis: Redis, email: str, ip: str) -> None:
    keys = (f"login:fail:acct:{email}", f"login:fail:ip:{ip}")
    counts = await redis.mget(keys)
    if int(counts[0] or 0) >= 5 or int(counts[1] or 0) >= 50:
        raise HTTPException(
            status_code=429,
            detail="Too many attempts, try again later",
            headers={"Retry-After": "900"},
        )


async def record_login_failure(redis: Redis, email: str, ip: str) -> None:
    async with redis.pipeline(transaction=True) as p:
        for key in (f"login:fail:acct:{email}", f"login:fail:ip:{ip}"):
            p.incr(key)
            p.expire(key, 900, nx=True)   # window starts at first failure (Redis 7+)
        await p.execute()
```

Check the limit **before** running Argon2. Otherwise the limiter does not protect your CPU. Behind a proxy, derive the client IP from a trusted `X-Forwarded-For` hop, not the raw header.

### Generic errors everywhere

The same rule from section 2 applies to every auth endpoint: identical status, body and timing whether the account exists or not.

| Endpoint | Leaky response | Safe response |
| --- | --- | --- |
| Login | "No account with that email" | "Incorrect email or password" (401) |
| Forgot password | "Email not found" | "If the address is registered, a link has been sent" (202) |
| Refresh | "Refresh token reuse detected" | "Not authenticated" (401); log the reuse |
| Locked account | "Account locked" before checking the password | Same 429 for any email over the limit |

### Password reset token design

A reset token is a temporary password, so treat it like one.

1. **Generate** with a CSPRNG: `secrets.token_urlsafe(32)` (256 bits).
2. **Store only a hash** (`sha256(token)`) with `user_id`, `expires_at`, `used_at`. A DB leak should not let anyone reset passwords. OWASP says store tokens securely; hashing is the straightforward way to do it.
3. **Short TTL**: 15 to 60 minutes. A Redis key `pwreset:{sha256}` -> `user_id` with `EX 1800` gives you expiry for free.
4. **Single use**: delete or mark used atomically when consumed (`GETDEL` in Redis).
5. **Invalidate on use**: set `tokens_valid_after` so all existing sessions and refresh families die, and delete any other outstanding reset tokens for that user.
6. **Build the link from config**, not the `Host` header (host-header injection would send the victim a link to the attacker's domain). Serve the reset page with `Referrer-Policy: no-referrer` so the token does not leak to third-party scripts.
7. **Rate limit** reset requests per account and IP, so nobody can flood an inbox.

In the capstone, sending the email is a natural Kafka use case: publish `auth.password_reset_requested` and let the notification worker send it, which also keeps response time identical for known and unknown emails.

### MFA in brief: TOTP

TOTP (RFC 6238) is the authenticator-app six-digit code. Mechanism: at enrollment the server generates a random secret and shows it as a QR code. Both sides then compute `HOTP(secret, floor(unix_time / 30))` and truncate to six digits. The server accepts the current step and usually one step either side to tolerate clock drift.

Implementation points: store the TOTP secret encrypted (not hashed; you need it to compute codes); reject a code that was already accepted in the same time step (RFC 6238 requires no replay); rate limit code attempts, since six digits is only a million options; issue one-time recovery codes, stored hashed like passwords. Login becomes two steps: password success returns a short-lived "mfa\_pending" token, and only the TOTP step issues real access and refresh tokens. `pyotp` is the common Python library. For the capstone, MFA is optional reading, not a Build task.

**Pitfalls**

- Rate limiting by IP only. Botnets have millions of IPs.
- Running the expensive hash before the limit check.
- Reset tokens that never expire, or survive a successful reset.
- Logging reset URLs or tokens in access logs.
- Letting a password change or reset leave old refresh families alive.

## Apply it to the capstone

Work through the Build tasks in this order; each one depends on the previous. The sketches show shape and key decisions, not finished code.

### 1. Register and login with argon2-cffi

- Migration: `users` gets `email` (unique, stored lower-cased; consider `citext`), `password_hash` (nullable for GitHub-only users), `role` (`'user'` default), `is_active`, `tokens_valid_after`.
- `POST /auth/register` takes JSON `{email, password}`; validate length 8 to 128 in the Pydantic model. Hash off the event loop.
- `POST /auth/login` accepts `OAuth2PasswordRequestForm` so the `/docs` Authorize button works. Order of operations: rate-limit check, `authenticate()` (dummy hash for unknown users), record failure or clear counter, rehash if needed, issue tokens.

```python
@router.post("/login")
async def login(form: Annotated[OAuth2PasswordRequestForm, Depends()], request: Request, ...) -> TokenPair:
    email = form.username.strip().lower()
    ip = client_ip(request)
    await check_login_allowed(redis, email, ip)
    user = await anyio.to_thread.run_sync(...)   # hint: wrap authenticate's hashing
    if user is None:
        await record_login_failure(redis, email, ip)
        raise HTTPException(401, "Incorrect email or password", headers={"WWW-Authenticate": "Bearer"})
    ...
```

### 2. Access tokens (15 min) and rotating refresh tokens

- Reuse `create_access_token` / `decode_access_token` from section 4. Put `jwt_secret` in settings from env; generate it with `python -c "import secrets; print(secrets.token_urlsafe(64))"`.
- Refresh token: a JWT with `typ` header `refresh+jwt`, claims `sub`, `jti`, `fam` (family UUID created at login), `exp` = 14 days. Login creates a new family; refresh keeps `fam` and mints a new `jti`.
- `POST /auth/refresh` uses `rotate_refresh` (section 5). Redis keys to design: `rt:used:{jti}` (TTL = remaining life), `rt:fam:revoked:{fam}` (TTL = max family life), `at:revoked:{jti}` (TTL = remaining access life).
- `POST /auth/logout` revokes the current access `jti` and the refresh family. Decide how the endpoint learns the family: accept the refresh token in the body.
- Question to answer for yourself: will `get_current_user` check `user.tokens_valid_after` against `iat`? (Recommended: yes, it costs nothing once you load the user.)

### 3. current\_user and /users/me/bookings

- Implement `get_current_user` with `SecurityScopes` as in section 6. Define `CurrentUser` and `AdminUser` aliases in `app/auth/deps.py`.
- Delete `GET /users/{user_id}/bookings`. Add `GET /users/me/bookings` that calls `BookingService.list_for_user(user.id)`.
- Booking creation takes the user from the token, never from the body. The `booking.created` Kafka event should carry `user_id` from the token too, so the worker notifies the right person.

### 4. Ownership checks and admin-only event creation

- Repository: replace `get(booking_id)` with `get_owned(booking_id, owner_id)` and `list_owned(owner_id)`. Grep the codebase for every remaining unscoped booking query.
- `GET /bookings/{id}` and `POST /bookings/{id}/cancel` go through the service, which raises `Forbidden` for someone else's booking. Map domain exceptions to HTTP in one exception handler.
- `POST /events` (and PATCH/DELETE) depend on `AdminUser`. Seed one admin in a migration or a CLI command, never via a public endpoint.

### 5. Sign in with GitHub

- Register an OAuth App at GitHub with callback `http://localhost:8000/auth/github/callback`. Put client ID and secret in `.env` (and never in the compose file committed to git).
- Add `SessionMiddleware`; use the Authlib registration from section 7 with `code_challenge_method="S256"`.
- Create `external_identities` and an `IdentityService.link_or_create`. Only auto-link by email if GitHub marks it `primary` and `verified`.
- The callback ends by issuing your own token pair. For a pure API, returning JSON is fine for now; a real frontend would receive a one-time code and exchange it.

### 6. Rate limit /auth/login

- Wire `check_login_allowed` and `record_login_failure` from section 9. Use the same Redis client as the rest of the app.
- Return `429` with `Retry-After`. Do not reveal whether the account exists in the 429 either.

### Tests to write

```python
async def test_bookings_require_token(client):
    r = await client.get("/users/me/bookings")
    assert r.status_code == 401
    assert r.headers["www-authenticate"].startswith("Bearer")

async def test_expired_token_rejected(client, make_token):
    token = make_token(user_id=1, ttl=timedelta(seconds=-120))   # beyond the 30 s leeway
    r = await client.get("/users/me/bookings", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401
```

The remaining tests follow the same shape; write them yourself:

- [ ] 401 with no token and with an expired token
- [ ] 403 when user A reads or cancels user B's booking
- [ ] 403 when a non-admin calls `POST /events`; 201 for an admin
- [ ] Refresh with token R1 succeeds (returns R2); refresh with R1 again returns 401; R2 is now also rejected (family revoked)
- [ ] Five wrong passwords, then the sixth attempt (even with the right password) returns 429
- [ ] Unknown email and wrong password return byte-identical bodies

Hints: build a `make_token` fixture that calls your real `create_access_token` with a configurable TTL instead of sleeping. Use a fresh Redis DB (or `FLUSHDB`) per test for limiter and denylist state. Mock GitHub with `respx` or by overriding the identity service rather than calling the real API.

## Check yourself

1. A user with a valid token cancels someone else's booking. Is that an authentication or an authorization failure, and where should the fix live?
2. Why is SHA-256 with a per-user salt still a poor way to store passwords? What does memory hardness add?
3. What does `check_needs_rehash` let you do, and why can it only happen at login?
4. How can a login endpoint leak which emails are registered even when the error messages are identical?
5. Give two reasons to choose cookie sessions over bearer JWTs for a same-site browser app, and one reason to choose JWTs.
6. Explain the algorithm-confusion attack against RS256 and the one-line defense.
7. Why must you validate `aud`, even if the signature is valid?
8. Walk through refresh token rotation with reuse detection when an attacker steals a refresh token and uses it first.
9. How do you revoke a JWT access token before it expires without storing every issued token?
10. When should an API return 401, and when 403? What header goes with 401?
11. In authorization code + PKCE, what exactly does PKCE protect against, and what does `state` protect against?
12. You add "Sign in with GitHub". Why is linking to an existing local account by email risky, and what makes it safer?

## Answers

1. Authorization (BOLA). Authn correctly identified the caller. Fix it in the service/repository by scoping the query to `user_id`, so every caller path is covered.
2. SHA-256 is fast, so GPUs test billions of guesses per second; salts only stop precomputation and force per-hash work. Memory hardness makes each guess need many MiB, capping parallelism on GPUs and ASICs.
3. It detects hashes made with older or weaker parameters so you can rehash with current ones. You need the plaintext to rehash, and you only have it right after a successful verify.
4. Through timing (unknown email skips the slow hash) or status codes. Fix with a dummy-hash verify on the unknown path and identical responses.
5. Sessions: immediate revocation, and HttpOnly cookies keep the secret away from JavaScript. JWTs: verification without a shared store across many services, and natural fit for mobile and third-party clients.
6. The server verifies with an RSA public key but lets the token header pick the algorithm. The attacker signs with HS256 using the public key bytes as the HMAC secret. Defense: `algorithms=["RS256"]` pinned in code (and a library that refuses PEM keys for HMAC).
7. A valid signature only proves your issuer minted it. Without `aud`, a token issued for another service from the same issuer is accepted by yours.
8. Attacker refreshes with R1 and gets R2. Later the real client presents R1. R1 is already marked used, so the server revokes the whole family, including the attacker's R2. Both must log in again; only the real user can.
9. Store only revoked `jti`s in Redis with TTL equal to the token's remaining lifetime, and check on each request. Or a per-user `tokens_valid_after` timestamp compared with `iat`.
10. 401 when the caller is not authenticated (missing, invalid, expired, revoked token), with `WWW-Authenticate: Bearer` (plus `error="invalid_token"` if a token was sent). 403 when the caller is known but not allowed (scope, role, ownership).
11. PKCE: a stolen authorization code cannot be redeemed without the verifier that only the original client holds. `state`: a forged callback (login CSRF) where an attacker makes you complete their login.
12. If the provider lets someone attach an unverified email, the attacker takes over the local account with that email. Only link on a verified primary email, or require the user to log in locally first and link explicitly.

## Sources

All pages below were opened while writing these notes (October 2026). Library snippets were run against PyJWT 2.15.0, argon2-cffi 25.1.0 and Authlib 1.9.1.

**Standards**

- [RFC 6749: The OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749)
- [RFC 6750: Bearer Token Usage (error codes, WWW-Authenticate)](https://datatracker.ietf.org/doc/html/rfc6750#section-3.1)
- [RFC 7519: JSON Web Token (registered claims)](https://datatracker.ietf.org/doc/html/rfc7519#section-4.1)
- [RFC 7636: Proof Key for Code Exchange (PKCE)](https://datatracker.ietf.org/doc/html/rfc7636)
- [RFC 8725: JSON Web Token Best Current Practices](https://datatracker.ietf.org/doc/html/rfc8725)
- [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://datatracker.ietf.org/doc/rfc9700/)
- [RFC 6238: TOTP](https://datatracker.ietf.org/doc/html/rfc6238)
- [OAuth 2.1 draft (draft-ietf-oauth-v2-1)](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/)

**OWASP**

- [Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
- [API1:2023 Broken Object Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/)

**Library and provider docs**

- [FastAPI: OAuth2 with Password (and hashing), Bearer with JWT tokens](https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/)
- [FastAPI: OAuth2 scopes](https://fastapi.tiangolo.com/advanced/security/oauth2-scopes/)
- [PyJWT usage examples](https://pyjwt.readthedocs.io/en/stable/usage.html)
- [argon2-cffi API reference](https://argon2-cffi.readthedocs.io/en/stable/api.html)
- [Authlib: Starlette OAuth client](https://docs.authlib.org/en/latest/client/starlette.html)
- [Authlib: FastAPI OAuth client](https://docs.authlib.org/en/v1.5.0/client/fastapi.html)
- [GitHub: Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [oauth.com: PKCE authorization request](https://www.oauth.com/oauth2-servers/pkce/authorization-request/)
- [Auth0: Refresh token rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation)
