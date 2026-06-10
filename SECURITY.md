# Security Review — IonSync v2

_Last reviewed: 2026-06-10. Scope: `packages/server`, `packages/plugin`, Docker
deployment, and the admin dashboard. This document records the threat model,
known issues, and recommended remediations._

---

## Threat model

IonSync is a self-hosted sync server. Its security rests on **one shared
password** that every device knows. That password:

1. Authenticates the plugin to the server (WebSocket challenge-response).
2. Gates the admin dashboard.
3. Derives the E2EE content key (when E2EE is enabled).

Because all three reuse the same secret, anyone who holds the sync password is,
by design, fully trusted: they can read, write, and delete any file, and they
can administer the server. The goal of this document is therefore to protect
against **everyone who does _not_ hold the password** — network attackers,
people who reach the dashboard, and a compromised or impersonated server — and
to make the trust boundaries explicit.

A note on deployment: the admin dashboard is intentionally reachable from the
network (not localhost-only), because operators want to manage it remotely. That
is a legitimate choice, but it means the dashboard must be hardened as a
genuinely internet-facing surface — TLS, a real session token, cookie flags,
CSRF protection, and rate limiting — rather than relying on network isolation.

---

## Severity summary

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Admin session token is a static function of the password | **High** | Open |
| 2 | TOTP (2FA) is bypassable by any password-holder | **High** | Open |
| 3 | Admin server runs plain HTTP; cookie lacks `Secure`/`SameSite` | **High** | Open |
| 4 | Plugin executes server-pushed JS with no signature check | **High** | Open |
| 5 | E2EE export endpoint decrypts server-side (key leaves the client) | **High** | Open |
| 6 | CSRF on cookie-authenticated, state-changing endpoints | **Medium** | Open |
| 7 | Fixed global PBKDF2 salt; low iteration count | **Medium** | Open |
| 8 | No constant-time comparison of secrets | **Medium** | Open |
| 9 | No rate limiting / lockout on auth | **Medium** | Open |
| 10 | TOTP secret stored in plaintext | **Medium** | Open |
| 11 | Long-lived AES-GCM key, no rotation | **Low** | Open |

---

## High severity

### 1. Admin session token is a static function of the password

`buildAdminRouter` sets the session cookie to:

```
DASH_TOKEN = sha256(password + "-dashboard")
```

This value is deterministic, never rotates, and is identical for the life of the
password. Anyone who knows the password can compute it offline and set the
cookie directly — no login flow required. A token that leaks once is valid
forever (until the password changes).

**Fix:** issue a random session token on successful login
(`crypto.randomBytes(32)`), store a hash of it server-side with an expiry, and
compare incoming cookies against the stored value. This makes sessions
revocable and decouples the cookie from the password.

### 2. TOTP (2FA) is bypassable by any password-holder

TOTP only gates the `/api/login` → `grantSession` path. But because the session
cookie (issue #1) is `sha256(password + "-dashboard")`, a password-holder can
compute the cookie value directly and skip the TOTP step entirely. 2FA
therefore provides no protection against anyone who knows the password — which
is every synced device.

**Fix:** depends on #1. Once the session token is random and server-issued, it
can only be obtained by completing the full login flow (including TOTP), and the
second factor becomes meaningful.

### 3. Admin server runs plain HTTP; cookie lacks `Secure`/`SameSite`

Only the public/WebSocket server can be configured with TLS. The admin server
(`adminServer = http.createServer(...)`) is always plain HTTP, so the password
(sent in the `X-Dashboard-Password` header) and the session cookie travel in
cleartext. The cookie is also set without `Secure` or `SameSite`:

```
dash_token=...; Path=/; Expires=...; HttpOnly
```

**Fix:** since the dashboard is exposed remotely, terminate TLS in front of it
(reverse proxy such as Caddy/nginx, or give the admin server its own
`https.createServer` using the existing `tls` config). Add `Secure` and
`SameSite=Strict` to the cookie. If a plaintext deployment is ever unavoidable,
restrict the admin port to a VPN/private network.

### 4. Plugin executes server-pushed JavaScript with no verification

`version_check_response` delivers `main.js`, `styles.css`, and `manifest.json`
as base64, and the plugin hot-reloads them. There is no signature check, and the
protocol authenticates only the client to the server — never the server to the
client. Over plain `ws://`, a MITM or rogue server can push arbitrary code that
runs inside Obsidian with full vault and filesystem access. This is a
remote-code-execution path.

**Fix:** sign update bundles with a key the plugin pins, and verify the
signature before applying. At minimum, refuse to apply auto-updates over a
non-TLS (`ws://`) connection, and surface an explicit user confirmation before
hot-reloading new plugin code.

### 5. E2EE export endpoint decrypts server-side

`/api/export-snapshot` accepts an `X-E2EE-Password` header, derives the AES key
on the server, and decrypts file content into the ZIP (logging the derivation).
This defeats the end-to-end property: the passphrase and plaintext both pass
through the server. The dashboard _preview_ path decrypts in-browser (correct);
only the export path is affected.

**Fix:** build the ZIP and decrypt entirely client-side in the browser (the
dashboard already has the WebCrypto code for preview). The server should only
ever return ciphertext for E2EE files. Remove the `X-E2EE-Password` handling and
the associated logging.

---

## Medium severity

### 6. CSRF on cookie-authenticated, state-changing endpoints

Authentication is cookie-based with no anti-CSRF token and no `SameSite` flag,
and several state-changing operations are exposed over **GET** (e.g.
`/api/action/:action/:peerId`, which disconnects a peer). A malicious page the
operator visits while logged in can drive these endpoints.

**Fix:** add `SameSite=Strict` (issue #3), require all mutating actions to be
POST/DELETE, and add a CSRF token (double-submit cookie or per-session token in
a header).

### 7. Fixed global PBKDF2 salt; low iteration count

E2EE key derivation uses a fixed application-wide salt
(`"IonSync-AES-GCM-v1-salt"`) at 100,000 iterations. The same password produces
the same key for every user and vault, enabling precomputation and cross-vault
key reuse. The fixed salt is documented as intentional (devices must derive a
common key), but the trade-off should be explicit.

**Fix:** generate a random per-vault salt once, distribute it across devices
during the password handshake, and store it alongside the encrypted data. Raise
iterations (≥600k for PBKDF2-SHA256) or move to Argon2id.

### 8. No constant-time comparison of secrets

Password, session token, WS auth token, and TOTP code are all compared with
`!==`/`===` (`handleAuth`, `checkAuth`, `/api/login`, `verifyTOTP`). These leak
timing information.

**Fix:** use `crypto.timingSafeEqual` for the password, session token, and auth
token comparisons (guarding for equal length first).

### 9. No rate limiting / lockout on auth

Neither the dashboard login nor the WebSocket auth has rate limiting or
lockout. The single shared password is freely brute-forceable.

**Fix:** add IP-based rate limiting and exponential backoff on failed
`/api/login` attempts and failed WS auth; consider a temporary lockout.

### 10. TOTP secret stored in plaintext

`totp_secret` is stored unencrypted in the settings table. A database read fully
compromises 2FA.

**Fix:** encrypt the TOTP secret at rest with a key derived from the server
password (or a dedicated server key), or accept the risk explicitly given the
DB already holds all file content.

---

## Low severity

### 11. Long-lived AES-GCM key, no rotation

E2EE uses a long-lived key with random 96-bit IVs and no rotation mechanism.
IV-uniqueness relies entirely on the RNG; after ~2⁴⁸ encryptions the birthday
bound on IV collisions becomes a (theoretical) concern. Acceptable for typical
vault sizes, but there is no key-rotation path if the password is ever exposed.

**Fix:** document a re-key procedure (re-encrypt the vault under a new password)
and track encryption counts if vaults grow very large.

---

## Correctness bugs with security-adjacent impact

These are not vulnerabilities but cause silent data loss or dead security
features, and should be fixed or removed so the security posture is honest:

- **Delta-patch mode is broken.** `ws/server.ts` calls `ctx.storage.read(...)`,
  which does not exist on `Storage` (only `readLatest`/`readVersion`). `mode:
  "patch"` always throws, is swallowed, and the edit is silently dropped. Either
  implement it correctly or remove the branch.
- **`trigger-sync` admin action is a no-op** — it sends `sync_done` to an idle
  peer instead of initiating a sync, and can falsely signal completion.
- **`/api/sync/background` is an empty stub** returning `{ ok: true }`. Remove it
  (and the unused `diff_match_patch` import in `routes.ts`) or implement it.
- **Duplicate TOTP route block** — `/api/totp/{status,generate,enable,disable}`
  is registered twice; the second copy is dead. Remove it.
- **File-size limit not enforced on bulk-sync push** (`drainPushQueue` reads and
  pushes oversized files regardless of `maxFileSizeMb`).
- **Crafted paths can 500 the server** — `/api/file-content` doesn't catch the
  traversal exception thrown by `Storage.resolve` (traversal is correctly
  blocked, but returns a 500 instead of a clean 400).

---

## What is already solid

- Path traversal is well-guarded in `Storage.resolve` and most routes.
- All SQL uses parameterized prepared statements (`better-sqlite3`).
- SHA1 verification rejects corrupted uploads.
- WAL mode, migrations, and chunked sync with backpressure are sound.
- Deleted-file retention (kept until all devices have synced the deletion) is
  thoughtfully designed.

---

## Reporting a vulnerability

Please report security issues privately to the maintainer rather than opening a
public issue. Include reproduction steps and the affected component.
