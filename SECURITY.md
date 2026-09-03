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
| 3 | Admin server runs plain HTTP; cookie lacks `Secure`/`SameSite` | **High** | ✅ Fixed (`SameSite` + optional TLS + conditional `Secure`) |
| 4 | Plugin executes server-pushed JS with no signature check | **High** | ✅ Fixed (ed25519-signed updates) |
| 5 | E2EE export endpoint decrypts server-side (key leaves the client) | **High** | ✅ Fixed (client-side decrypt + ZIP) |
| 6 | CSRF on cookie-authenticated, state-changing endpoints | **Medium** | ✅ Fixed (`SameSite` + per-session CSRF token; mutations off GET) |
| 7 | Fixed global PBKDF2 salt; low iteration count | **Medium** | ✅ Fixed (600k iters + opt-in per-install salt, format v3) |
| 8 | No constant-time comparison of secrets | **Medium** | ✅ Fixed |
| 9 | No rate limiting / lockout on auth | **Medium** | ✅ Fixed |
| 10 | TOTP secret stored in plaintext | **Medium** | ✅ Fixed (sealed at rest, AES-GCM under a password-derived key) |
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

**Still open**

None — every item in this document has been fixed or addressed. Remaining
hardening is opportunistic (e.g. Argon2id in place of PBKDF2), not an open gap.

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

### 3. Admin server runs plain HTTP; cookie lacks `Secure`/`SameSite` — ✅ Fixed

**Was:** only the public/WebSocket server could use TLS. The admin server was
always plain HTTP, so the password (`X-Dashboard-Password` header) and the
session cookie travelled in cleartext, and the cookie was set without `Secure`
or `SameSite`.

**Fixed:**
- `SameSite=Strict` was added (see #1/#2), which also blunts CSRF (#6).
- The admin server now terminates TLS itself when `adminTls: { key, cert }` is
  set in config — the same optional `https.createServer` treatment the public
  server already had, but independent of `tls` so the dashboard can use a
  local/self-signed cert. Left unset, the dashboard stays on plain HTTP (no
  change for a loopback/LAN deployment).
- The session cookie gains `Secure` **conditionally**, based on `req.secure` —
  true when the admin server terminated TLS (`adminTls`) or when a trusted
  reverse proxy did and forwarded `X-Forwarded-Proto: https` (enable
  `trustProxy: true` only behind such a proxy). This covers both deployment
  models — native TLS or a Caddy/nginx/Traefik front — without a forced HTTPS
  requirement that would break a plain-HTTP LAN dashboard by making the browser
  silently drop the cookie.

So a homelab user can keep plain HTTP on a private network, put the dashboard
behind a TLS proxy, or give it its own cert — and in every TLS case the cookie
is marked `Secure`. Regression test: `test/adminCookie.test.ts` asserts `Secure`
appears over HTTPS (trusted proxy), is absent over plain HTTP, and that a
**spoofed** `X-Forwarded-Proto` is ignored unless `trustProxy` is set.

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

### 6. CSRF on cookie-authenticated, state-changing endpoints — ✅ Fixed

**Was:** cookie-based auth with no anti-CSRF token and no `SameSite`, and a
state-changing operation exposed over **GET** (`/api/action/:action/:peerId`,
which disconnects a peer / triggers a sync) — reachable by a cross-site
`<img>`/navigation, and the rest by a cross-site form/fetch riding the cookie.

**Fixed — three layers:**
- `SameSite=Strict` on the session cookie (shipped with #1/#2) — the primary
  defence: the browser won't attach the cookie to a cross-site request at all.
- **Mutations off GET:** `/api/action/...` moved from GET to **POST**, so no
  state change is reachable by a bare cross-site navigation or image load. The
  other mutating endpoints were already POST/DELETE/PATCH.
- **Per-session CSRF token** (defence-in-depth). Each session gets a second
  random secret bound to it server-side. The login response returns it (and
  `GET /api/csrf` re-issues it to a reloaded dashboard that holds the cookie but
  not the token). A router-level guard rejects any non-safe method (POST/PUT/
  PATCH/DELETE) whose `X-CSRF-Token` header doesn't match the session's token
  (constant-time compare), exempting only the pre-session login pair. The
  dashboard wraps `fetch` once to attach the header to every mutating call.
  Because the token never rides a cookie, a cross-site page cannot read it to
  forge the header — even if `SameSite` were ever weakened or bypassed.

Regression tests: `test/csrf.test.ts` (missing/wrong/valid token → 403/403/pass,
the action route is POST-only, `GET /api/csrf` auth-gated) and the existing
admin-action tests now log in for the CSRF token.

### 7. Fixed global PBKDF2 salt; low iteration count — ✅ Fixed

**Was:** E2EE key derivation used a fixed application-wide salt
(`"IonSync-AES-GCM-v1-salt"`) at 100,000 iterations. The same password produced
the same key for every install and vault, enabling precomputation against the
known salt and cross-install key reuse.

**Fixed in two parts:**
- **Iterations 100k → 600k** (OWASP 2023 floor for PBKDF2-SHA256). The count is
  pinned per format version (v1=100k legacy, v2/v3=600k) so old ciphertext stays
  decryptable — the key is re-derived on decrypt using the version stamped in the
  blob's magic.
- **Per-install random salt (format v3), opt-in.** The server generates a random
  16-byte salt once (`db.getOrCreateE2eeSalt`, stored in settings, stable for the
  vault's life; not secret) and hands it to every device in `auth_ok`. The plugin
  persists it locally, so v3 content decrypts offline and independent of the
  server after first receipt. v3 derives the key with this salt instead of the
  global one, defeating precomputation and cross-install reuse.

**Safe rollout.** Shipping the v3-capable build changes nothing on its own:
`WRITE_VERSION` stays 2 until the user turns on "Per-install encryption salt (v3)"
in settings, which is only enabled once a salt has been received. *Reading* v3
needs only the salt; *writing* v3 needs the explicit opt-in — so a device that
hasn't been updated never meets a v3 blob it can't read. Existing v1/v2 files
remain readable forever (the version byte selects the salt), and "Re-encrypt all
files" migrates them to v3 after the opt-in. (The upload handler's echo-storm
guard makes an explicit exception for a re-key: a re-upload with the same
plaintext SHA-1 but a different ciphertext format version is stored rather than
dropped — without it the migration of an already-encrypted note would silently
no-op. See `isNoopResend` and `test/reEncrypt.test.ts`.) Verified end-to-end: v2 and v3
round-trip, a v3 blob is rejected under the wrong salt, old v2 blobs still
decrypt with a v3 salt loaded, and v3 derivation fails closed when no salt is
present. Salt distribution is covered by `test/e2eeSalt.test.ts` (well-formed,
delivered on auth, identical across reconnects).

_Note:_ the global salt (`IonSync-AES-GCM-v1-salt`) is retained solely to read
pre-v3 (v1/v2) blobs; all new derivation for opted-in installs uses the random
per-install salt.

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

### 10. TOTP secret stored in plaintext — ✅ Fixed

**Was:** `totp_secret` was stored unencrypted in the settings table, so anyone
who read the SQLite file — or one of the automated backups — could clone the
authenticator. (The backups feature makes this concrete: a snapshot copied
off-box would have carried the plaintext seed.)

**Fixed:** the seed is now sealed at rest (`src/totpSecret.ts`) with AES-256-GCM
under a key derived (PBKDF2-SHA256, 200k) from the **admin password** — which the
running server already holds — plus the per-install salt, domain-separated from
E2EE use. The stored form is `base64(MAGIC + IV + ciphertext + tag)`. A leaked DB
or backup no longer exposes the seed; an attacker would also need the admin
password, at which point the second factor is already moot.

- Enable seals the secret (`writeTotpSecret`); login/verify and disable read it
  back through `readTotpSecret` (existence checks in `/api/login` and
  `/api/totp/status` work directly on the opaque blob).
- **Backward compatible:** `openTotpSecret` returns a value lacking the magic
  verbatim, so a pre-existing plaintext secret keeps working, and a one-time
  startup migration in `index.ts` re-seals it (idempotent; sealed secrets are
  skipped).

Tests (`test/totpSecret.test.ts`): round-trip, fresh IV per seal, legacy
plaintext passthrough, and authentication failure on a wrong password, wrong
salt, or tampered ciphertext.

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
