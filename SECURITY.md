# Security Review — IonSync v2

_Last reviewed: 2026-06-10 · **re-audited 2026-09-02** (statuses below reflect current `main`; see the Re-audit summary). Scope: `packages/server`, `packages/plugin`, Docker
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

| # | Issue | Severity | Status (2026-09-02) |
|---|-------|----------|--------|
| 1 | Admin session token is a static function of the password | **High** | ✅ Fixed (random server-issued token) |
| 2 | TOTP (2FA) is bypassable by any password-holder | **High** | ✅ Fixed (via #1) |
| 3 | Admin server runs plain HTTP; cookie lacks `Secure`/`SameSite` | **High** | Open — `SameSite` added; HTTP + `Secure` remain |
| 4 | Plugin executes server-pushed JS with no signature check | **High** | ✅ Fixed (ed25519-signed updates) |
| 5 | E2EE export endpoint decrypts server-side (key leaves the client) | **High** | ✅ Fixed (client-side decrypt + ZIP) |
| 6 | CSRF on cookie-authenticated, state-changing endpoints | **Medium** | Open — mitigated by `SameSite=Strict` |
| 7 | Fixed global PBKDF2 salt; low iteration count | **Medium** | Partial — iterations 100k→600k; salt still global |
| 8 | No constant-time comparison of secrets | **Medium** | ✅ Fixed |
| 9 | No rate limiting / lockout on auth | **Medium** | ✅ Fixed |
| 10 | TOTP secret stored in plaintext | **Medium** | Open |
| 11 | Long-lived AES-GCM key, no rotation | **Low** | ✅ Addressed (re-encrypt/re-key shipped) |

---

## Re-audit summary (2026-09-02)

Every item below was re-verified against current `main`. Substantial progress
since the June review.

**Fixed**
- **#1 / #2 Admin session token & TOTP bypass** — the admin cookie is now a
  random, server-issued token (kept only as a SHA-256 + expiry in an in-memory
  store), replacing `sha256(password+"-dashboard")`. A session exists only after
  a completed `/api/login` (+ TOTP when enabled), so a password-holder can no
  longer compute the cookie or skip the second factor.
- **#4 Unsigned plugin auto-update (RCE)** — update bundles (`main.js`) are now
  **ed25519-signed at build time** with a key the running server never holds
  (`IONSYNC_SIGN_KEY` build secret). The plugin pins the public key
  (`updateKey.ts`) and verifies before hot-reloading, **failing closed** on a
  missing/invalid signature. Transport-independent — protects `ws://` and
  `wss://` alike, so it imposes no TLS requirement. Crypto lives in
  `protocol/updateSig.ts` (unit-tested).
- **#8 Constant-time comparison** — `timingSafeEqual` now backs the dashboard
  cookie/password (`secretsMatch`, `http/routes.ts`) and the WS auth token
  (`ws/handlers/auth.ts`).
- **#9 Rate limiting** — `ConnectionRateLimiter` gates `/api/login` (per-IP,
  429 on excess) and WS connections (`ws/rateLimit.ts`).
- **#11 Key rotation** — a "Re-encrypt all files" action (Settings →
  `triggerReEncrypt` → `Storage.bumpAllMtimesForReEncrypt`) is the re-key path
  the fix asked for. The theoretical IV-collision bound is unchanged.
- **Correctness bugs** — delta-patch now uses `readLatest` + `patch_apply`;
  `trigger-sync` sends a real `request_sync`; the `/api/sync/background` stub and
  its `diff_match_patch` import are gone; the duplicate TOTP route block is gone;
  bulk-push (`drainPushQueue`) enforces the size limit; and `/api/file-content`
  returns a clean 400 (not 500) on a blocked traversal. All six are fixed.

**Partially fixed**
- **#7** — PBKDF2 iterations raised **100k → 600k** (v2; v1 retained only to read
  legacy blobs). The global fixed salt (`IonSync-AES-GCM-v1-salt`) remains, still
  documented as an intentional cross-device trade-off.
- **#3** — the cookie now carries `SameSite=Strict` (which also blunts #6), but
  the admin server is still plain HTTP and the cookie has no `Secure`.

**Still open — priority order**
1. **#3 Admin TLS** + cookie `Secure`.
2. **#6 CSRF token** + POST/DELETE for mutating actions (mitigated by SameSite).
3. **#10 TOTP secret** stored plaintext.

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

> **Fixed (2026-09-02):** ed25519-signed update bundles, verified against a
> pinned public key before hot-reload; fails closed. See the Re-audit summary.

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

### 5. E2EE export endpoint decrypts server-side — ✅ Fixed

**Was:** `/api/export-snapshot` and `/api/export-selected` accepted an
`X-E2EE-Password` header, derived the AES key on the server, and decrypted file
content into a server-built ZIP (logging the derivation) — the passphrase and
plaintext both passed through the server, defeating the end-to-end property.

**Fixed:** both routes now return a JSON manifest of the stored bytes
(`{ files: [{ path, mtime, encrypted, content(base64) }] }`) and **never
decrypt**. Encrypted files come back exactly as stored (the `IONENCv…` blob);
the dashboard loads JSZip (already CSP-allowed) and decrypts each E2EE entry
in-browser with the vault key via the same `e2eeDecryptB64` used by preview,
then assembles the ZIP client-side. The `X-E2EE-Password` header and all
server-side decryption/logging are removed, so the passphrase never leaves the
browser. Regression test: `test/exportSecurity.test.ts` asserts the server
returns ciphertext byte-for-byte even when handed the passphrase.

_Trade-off:_ the manifest carries all selected file bytes as base64 in one
response (the browser then zips them), rather than the previous streamed ZIP.
Fine for personal vaults; a future manifest-then-fetch-per-file path could
restore streaming for very large exports if ever needed.

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

- ✅ **Delta-patch mode** — **Fixed (2026-09):** `ws/server.ts` now reads via
  `ctx.storage.readLatest` and applies with `diff_match_patch.patch_apply`.
- ✅ **`trigger-sync` admin action** — **Fixed (2026-09):** sends `request_sync`
  so the client actually runs a cursor catch-up.
- ✅ **`/api/sync/background` stub** — **Fixed (2026-09):** endpoint and the
  unused `diff_match_patch` import removed from `routes.ts`.
- ✅ **Duplicate TOTP route block** — **Fixed (2026-09):** registered once.
- ✅ **File-size limit on bulk-sync push** — **Fixed (2026-09):** `drainPushQueue`
  (`ws/handlers/sync.ts`) skips files over `maxFileSizeMb`.
- ✅ **Crafted paths can 500 the server** — **Fixed (2026-09):** `/api/file-content`
  now catches the `Storage.resolve` traversal throw and returns a clean 400.

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
