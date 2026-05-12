# CLAUDE.md — IonSync v2

This file provides guidance for working in the `v2/` monorepo. Read it in full before making any changes.

---

## Repository layout

```
v2/
├── package.json              # npm workspace root
├── pnpm-workspace.yaml       # pnpm workspace config (for local dev on Windows)
├── tsconfig.base.json        # shared strict TypeScript base
├── Dockerfile                # multi-stage production image (server only)
├── docker-compose.yml        # compose file — mounts /data volume, reads .env
├── docker-entrypoint.sh      # generates config.js from env vars at container start
├── .env.example              # copy to .env, set IONSYNC_PASSWORD
└── packages/
    ├── protocol/             # shared message types (client & server)
    │   └── src/index.ts
    ├── server/               # Node.js sync server
    │   ├── src/
    │   ├── client/           # dashboard.html + built plugin files (served at /dashboard)
    │   ├── test/
    │   └── config.example.js
    └── plugin/               # Obsidian plugin (TypeScript, bundled by esbuild)
        ├── src/
        ├── manifest.json
        └── esbuild.config.mjs
```

The three packages share a single `node_modules` tree via npm workspaces. `@ionsync/protocol` is referenced with the version `"*"` so npm resolves it from the workspace without a publish step.

---

## Docker

### Quick start
```bash
cp .env.example .env          # set IONSYNC_PASSWORD
docker compose up -d
# Dashboard: http://localhost:3000/dashboard
```

### Build image manually
```bash
docker build -t ionsync .
docker run -d -p 3000:3000 -v ionsync_data:/data \
  -e IONSYNC_PASSWORD=secret ionsync
```

### Configuration in Docker

Two options — pick one:

**Option A — env vars (simplest):**
Set `IONSYNC_PASSWORD` (required) in `.env` or `docker-compose.yml`. Other vars are optional:

| Variable | Default | Description |
|---|---|---|
| `IONSYNC_PASSWORD` | *required* | Shared password for plugin + dashboard |
| `IONSYNC_PORT` | `3000` | Port the server listens on inside the container |
| `IONSYNC_HOST` | `0.0.0.0` | Bind address |
| `IONSYNC_LOG_LEVEL` | `3` | 0=silent 1=error 2=warn 3=info |
| `IONSYNC_VERSIONS_PER_FILE` | `5` | Max stored versions per file |
| `IONSYNC_CLEANUP_INTERVAL` | `3600` | Cleanup job interval in seconds |
| `IONSYNC_KEEP_DELETED_SECS` | `604800` | How long to keep deleted file records (7 days) |

**Option B — mount a config file:**
```yaml
volumes:
  - ./config.js:/app/config.js:ro
```
The entrypoint detects the file and skips env-var generation entirely.

### TLS in Docker
Mount certs and reference them in the config file:
```yaml
volumes:
  - ./config.js:/app/config.js:ro
  - ./certs:/certs:ro
```
```js
// config.js
export default {
  password: "...",
  tls: { key: "/certs/privkey.pem", cert: "/certs/fullchain.pem" },
  appDir: "/app",
  dataDir: "/data",
};
```

### Data persistence
The container exposes `/data` as a volume. This holds:
- `db/` — SQLite database (WAL mode)
- `files/` — versioned file content

Always mount a named volume or bind-mount so data survives container restarts.

### Build details (Dockerfile)
The image uses a two-stage build:
1. **Builder** (`node:20-alpine`) — installs native build tools (`python3 make g++`), compiles `@ionsync/protocol` then `@ionsync/server`, prunes dev deps.
2. **Runtime** (`node:20-alpine`) — copies production `node_modules`, replaces the npm workspace symlink for `@ionsync/protocol` with the compiled `dist/`, copies `packages/server/dist/` and `client/`.

The npm workspace symlink replacement is intentional: the runtime image does not include the full monorepo tree, so the symlink would dangle. The compiled protocol files are copied in-place instead.

---

## Commands

### Install everything (from `v2/`)
```bash
npm install
```

### Server — run in dev mode (tsx, no compile step)
```bash
cd packages/server
cp config.example.js config.js   # first time only — fill in password
npm run dev
```

### Server — typecheck
```bash
cd packages/server
npm run typecheck
```

### Server — run tests
```bash
cd packages/server
npm test
# expands to:
node --import tsx/esm --test --test-timeout=15000 test/sync.test.ts test/cleanup.test.ts
```

### Plugin — dev build (watch mode)
```bash
cd packages/plugin
npm run dev
# Bundles src/ → main.js, copies to server/client/ if it exists,
# and to $OBSIDIAN_PLUGIN_DIR if that env var is set.
```

### Plugin — production build
```bash
cd packages/plugin
npm run build   # tsc typecheck, then esbuild production bundle
```

### Plugin — typecheck only
```bash
cd packages/plugin
npm run typecheck
```

---

## Architecture

### `packages/protocol` — shared types

Single source of truth for every message that crosses the WebSocket. Both the server and the plugin import from here; never duplicate type definitions.

**Key exports:**
- `FileEntry` — `{ path, sha1, mtime, action: "active"|"deleted", fileType: "file"|"folder" }`
- `VersionEntry` — `{ mtime, sha1, receivedAt }`
- `ClientMsg` union — `AuthMsg | VersionCheckMsg | SyncMsg | FileEventMsg | FileDataUploadMsg | FileDataRequestMsg | FileHistoryRequestMsg`
- `ServerMsg` union — `ChallengeMsg | AuthOkMsg | AuthErrorMsg | FileEventResultMsg | FilePushMsg | FileDataResponseMsg | FileHistoryResponseMsg | VersionCheckResponseMsg | SyncDoneMsg`
- `compareFiles(client, server)` — returns `"client_newer" | "server_newer" | null`

**Important:** `VersionCheckMsg.build` is typed as `string`. The esbuild post-build plugin stamps `__IONSYNC_BUILD__` as a string (timestamp). Do not change this to `number`.

---

### `packages/server`

#### Config (`src/config.ts`)

Loaded at startup from `config.js` (ES module `export default { ... }`). For tests, use `mergeConfig({ password, port: 0, ... })` — it is synchronous and does not read the filesystem.

The `tls` field must only be set when TLS credentials are present (strict `exactOptionalPropertyTypes`):
```typescript
if (raw["tls"]) result.tls = raw["tls"] as TlsConfig;
// NOT: result.tls = raw["tls"] ?? undefined   ← this fails strict checks
```

#### Database (`src/db/`)

`SyncDB` wraps `better-sqlite3` (synchronous API). WAL mode and foreign keys are enabled in the constructor.

Schema (migration v1):
- `devices(id TEXT PK, last_online INTEGER)` — one row per device, updated on every WS message
- `files(path TEXT PK, sha1, mtime, received_at, action, file_type)` — current state of each file
- `file_versions(id AUTOINCREMENT, path, sha1, mtime, received_at)` — append-only version log

**Rules:**
- `upsertFile(entry)` always inserts into `file_versions` too — never bypass it to add a version row.
- Never edit past migrations. Add a new `version: N+1` entry to `MIGRATIONS` array.
- `getVersionsToTrim` uses a `[string, string, number]` type parameter for the prepared statement — the double-string is path, path (for the subquery), then count.

#### Storage (`src/storage/`)

Versioned file content on disk. Layout: `<dataDir>/files/<vault-path>/v_<mtime>`.

- All paths are validated against `path.relative(base, resolved).startsWith("..")` — never skip this check.
- `readLatest()` returns the file at the highest mtime (sorted descending by `listVersionMtimes`).
- `pruneVersions(path, keepCount)` removes all but the `keepCount` newest versions from both disk and DB.

#### WebSocket server (`src/ws/`)

`attachWebSocketServer()` creates a `WebSocketServer` on top of the existing HTTP/HTTPS server.

**Connection lifecycle:**
1. Server sends `{ type: "challenge", nonce: uuid }` immediately on connect.
2. Client must send `{ type: "auth", deviceId, token }` within 5 seconds or is disconnected.
3. Auth token formula: `SHA-256( nonce[0:16] + password + nonce[16:] )` (hex-encoded). Same formula in v1 — do not change.
4. On auth success: `{ type: "auth_ok" }`. On failure: `{ type: "auth_error" }`.
5. Client sends `{ type: "version_check", version, build }`.
6. Server compares against `client/build_info.json` and responds `{ needsUpdate: boolean, files?: Record<string, string> }`.

**Message routing (`src/ws/server.ts`):**
- All messages before auth → only `"auth"` is accepted; anything else triggers disconnect.
- After auth → switch on `msg.type` routes to the appropriate handler.
- `peer.deviceId` is set by `handleAuth`; `db.touchDevice()` is called on every subsequent message.

**Sync handler (`src/ws/handlers/sync.ts`):**
- Builds client and server maps from the `sync` message and `db.getAllFiles()`.
- For each server file: push to client if client doesn't have it and it's active; compare mtimes otherwise.
- For each client file the server has never seen: request upload via `file_event_result: "client_newer"`.
- Sends `sync_done` immediately if `pendingUploads` is empty after processing.

**File upload handler (`src/ws/handlers/fileData.ts`):**
- Verifies SHA1 of uploaded content before writing — rejects silently if mismatch (client retries on next sync).
- `wasPending = peer.pendingUploads.has(path)` — only sends `sync_done` when the upload was part of a sync session (`wasPending && size === 0`). A real-time upload outside of sync must NOT trigger `sync_done`.
- Calls `broadcastToPeers()` after every successful upload for live sync.

**`SyncPeer` (`src/ws/peer.ts`):**
- `pendingUploads: Set<string>` — paths the server is waiting to receive from this client.
- `authed: boolean` — false until `handleAuth` succeeds.
- `autoSync: boolean` — if false, the peer is not included in broadcasts.
- `nonce: string` — the challenge nonce, used only during auth.

#### HTTP routes (`src/http/routes.ts`)

- `GET /dashboard` — serves `client/dashboard.html` (falls back to a minimal built-in page).
- `GET /api/login` — password via `X-Dashboard-Password` header → sets `dash_token` cookie (7-day HttpOnly).
- `GET /api/logs` — returns in-memory log ring buffer (200 lines max).
- `GET /api/devices` — all registered devices with last_online timestamp.
- `GET /api/peers` — currently connected WS peers.
- `POST /api/action/:action/:peerId` — `disconnect` or `sync` a specific peer.
- `GET /api/files` — lists all active files in the DB (path, size, mtime, action). Folders and deleted entries are excluded.
- `GET /api/file-versions?path=<encoded>` — returns `{ versions: Array<{ sha1, mtime, receivedAt, size }> }` newest-first for a file. Used by the dashboard history tab.
- `GET /api/file-content?path=<encoded>[&mtime=<ms>]` — returns `{ content: base64, encrypted: boolean, mtime, size }`. Omit `mtime` for latest; pass it to fetch a specific stored version.
- `DELETE /api/delete-file/*` — marks a file deleted in DB and removes storage versions.

Dashboard auth uses a derived token: `SHA-256(password + "-dashboard")` stored as a cookie.

#### Cleanup (`src/cleanup/index.ts`)

`SyncCleanup.run()` does two things:
1. **Version pruning** — for every file in the DB, trims `file_versions` (and corresponding disk files) down to `config.cleanup.versionsPerFile`.
2. **Deleted file purge** — removes files whose `action = "deleted"` and `received_at` is older than `keepDeletedFilesSecs`, but only when `oldestDeviceOnline > cutoff`. This ensures every device has synced the deletion before the record disappears.

---

### `packages/plugin`

#### Entry point (`src/main.ts`)

`IonSyncPlugin extends Plugin`. Key lifecycle:
- `onload()` — loads settings, generates `deviceId` (UUID via `crypto.randomUUID()`) on first run, creates `XSync`, registers commands and settings tab, calls `xSync.enabled(true)` inside `onLayoutReady`.
- `onunload()` — calls `xSync.destroy()`.
- `saveSettings()` — also propagates `syncEnabled` to `ws.isEnabled`.

Settings are stored via Obsidian's `loadData()` / `saveData()`.

#### `WsManager` (`src/WsManager.ts`)

Native `WebSocket` (browser API). Manages connection lifecycle:
1. Opens socket to `ws[s]://host:port`.
2. Receives `challenge` → computes token → sends `auth`.
3. Receives `auth_ok` → sends `version_check`.
4. Receives `version_check_response`:
   - `needsUpdate: false` → emits `"connected"`.
   - `needsUpdate: true` → emits `"update_available"` with `{ files: { name, content }[] }`.
5. Any disconnect → emits `"disconnected"`, schedules reconnect with exponential backoff (1s → 30s max).

Auth token formula (mirrors server): `SHA-256( nonce[0:16] + password + nonce[16:] )` using `crypto.subtle.digest`.

The `__IONSYNC_VERSION__` and `__IONSYNC_BUILD__` literals are replaced by esbuild at bundle time. Do not rename them.

#### `XSync` (`src/XSync.ts`)

The core sync engine.

**Sync flow:**
1. `sync()` calls `storage.computeTree()` to scan the vault.
2. Sends `{ type: "sync", files: FileEntry[] }` in chunks of 2,000 files (yields between chunks to avoid blocking UI).
3. Always sends at least one `sync` message, even for an empty vault (server needs it to send `sync_done`).
4. Receives `file_event_result: "client_newer"` → calls `_uploadFile(path)`.
5. Receives `file_push` → calls `_applyServerFile(file, content)`.
6. Receives `sync_done` → clears `isSyncing`, calls `xNotify.setSyncSummary()`.

**Real-time events:**
- Vault `create`/`modify` → `_sendFileEvent()` (with optional per-path debounce via `XTimeouts`).
- Vault `delete` → queued in `deleteQueue`, flushed when connected.
- Vault `rename` → old path queued as delete, new path sent as create.
- If `autoSync` is off or disconnected, events accumulate in `unsentSessionEvents` and are flushed at the start of the next `sync()` call.

**One-shot response listeners** (`responseListeners` array): used to await `file_history_response` and `file_data_response` from async callers (modal dialogs). Each listener is a predicate; returning `true` removes it from the list.

**Public helpers for modals:**
- `listVersionHistory(path)` — sends `file_history` and resolves with the response.
- `downloadVersion(path, mtime?)` — sends `file_data mode:"send"` with optional mtime; resolves with `file_data_response`. Omit mtime for latest.
- `getE2eeKey()` — returns the cached/derived `CryptoKey` for the current encryption password, or `null` if E2EE is off. Exposed so modal code can decrypt content without accessing private state.

**Wake lock:** acquired during sync on mobile to prevent the screen from sleeping mid-transfer.

#### `Storage` (`src/Storage.ts`)

- Metadata stored at `<plugin-dir>/data/metadata.json` — one `FileEntry` per path.
- Delete queue stored at `<plugin-dir>/data/delete-queue.json`.
- `computeTree()` scans the vault using `FSAdapter.iterate()`, computes SHA-256 for changed files, and builds `this.tree: Record<string, FileEntry>`. SHA is skipped when stored mtime matches stat mtime.
- `abortTree()` sets an `aborted` flag checked inside the async iteration loop.
- File content is base64-encoded when sent over the wire; `write()` / `writeBinary()` decode before writing to vault.

#### `FSAdapter` (`src/FSAdapter.ts`)

Low-level wrapper around Obsidian's `vault.adapter`. Always use `normalizePath()` before passing paths to vault methods. `makeFolder()` creates every component of the path recursively to avoid race conditions.

#### `ExclusionFilter` (`src/ExclusionFilter.ts`)

Evaluated per-path before any sync event is sent or applied. Order of checks:
1. Trash path (`.trash/`)
2. Obsidian settings files (`.obsidian/themes/`, `app.json`, etc.) — each governed by a specific toggle
3. Hidden files (paths with a `.` component)
4. File-type extensions (images, audio, video, PDF)
5. Custom glob patterns from `exclusionList` setting

Always check `.obsidian/` subpaths before the generic hidden-file rule so per-category toggles take precedence.

#### `XNotify` (`src/XNotify.ts`)

Manages the status bar item and mobile indicator. All color constants are module-level: `STATUS_OK`, `STATUS_ERROR`, `STATUS_WARN`, `STATUS_SYNC`.

The status bar context menu uses a dynamic `require()` for the modal imports to break the circular reference (`XNotify → XSync → modals → XSync`).

#### `XTimeouts` (`src/XTimeouts.ts`)

Per-path debounced timers. `executeAll()` fires all pending timers immediately — called on focus change so edits made while the editor was in the background are sent promptly.

#### `esbuild.config.mjs`

Post-build plugin (`postBuildPlugin`):
1. Stamps `__IONSYNC_VERSION__` and `__IONSYNC_BUILD__` into `main.js`.
2. Updates `manifest.json` and `versions.json` from `package.json`.
3. Writes `build_info.json` (version + build timestamp).
4. Copies `main.js`, `styles.css`, `manifest.json` to `packages/server/client/` for auto-update distribution.
5. Optionally copies to `$OBSIDIAN_PLUGIN_DIR` for local dev convenience.

The `alias` option points `@ionsync/protocol` directly at the protocol `src/index.ts` so esbuild bundles it without a separate compile step.

---

## Protocol reference

### Authentication

```
Server → Client: { type: "challenge", nonce: "<64-char hex uuid>" }
Client → Server: { type: "auth", deviceId: "<stable uuid>", token: "<sha256 hex>" }
Token formula:   SHA-256( nonce[0:16] + password + nonce[16:] )
Server → Client: { type: "auth_ok" }  |  { type: "auth_error", message: "..." }
```

### Version check

```
Client → Server: { type: "version_check", version: "2.0.0", build: "1700000000000" }
Server → Client: { type: "version_check_response", needsUpdate: false }
             or: { type: "version_check_response", needsUpdate: true,
                   files: { "main.js": "<base64>", "styles.css": "<base64>", "manifest.json": "<base64>" } }
```

### Sync (bulk)

```
Client → Server: { type: "sync", files: FileEntry[] }   (chunked, 2000 per message)
Server → Client: { type: "file_event_result", path, result: "client_newer" }   (per file that needs upload)
Server → Client: { type: "file_push", file: FileEntry, content: "<base64>" }   (per file server is newer)
Client → Server: { type: "file_data", mode: "apply", file: FileEntry, content: "<base64>" }
Server → Client: { type: "sync_done" }   (when all pendingUploads resolved)
```

### Real-time file event

```
Client → Server: { type: "file_data", mode: "apply", file: FileEntry, content: "<base64>" }
Server → Peers:  { type: "file_push", file: FileEntry, content: "<base64>" }   (broadcast)
```

### File download (restore version)

```
Client → Server: { type: "file_data", mode: "send", path: "notes/foo.md" }
             or: { type: "file_data", mode: "send", path: "notes/foo.md", mtime: 1700000000000 }
Server → Client: { type: "file_data_response", file: FileEntry, content: "<base64>" }
```

`mtime` is optional. When omitted the server returns the latest stored version. When provided the server calls `storage.readVersion(path, mtime)` to return that specific historical version. Used by `VersionHistoryModal` to preview and restore individual versions.

### File history

```
Client → Server: { type: "file_history", path: "notes/foo.md" }
Server → Client: { type: "file_history_response", path, versions: VersionEntry[] }
```

### Conflict resolution

Last-write-wins by **client mtime** (millisecond epoch). `compareFiles(client, server)` returns:
- `null` — same SHA1 and action; no action needed.
- `"client_newer"` — client mtime is strictly greater; server requests upload.
- `"server_newer"` — server mtime is greater or equal (tie goes to server); server pushes.

---

## Non-obvious behaviours

**Deleted files are never immediately purged.** When a file is deleted, its DB row is updated to `action = "deleted"` and its content versions are preserved. `SyncCleanup` only removes deleted records after `keepDeletedFilesSecs` has elapsed AND all known devices have come online at least once since the deletion. This ensures every device receives the delete broadcast before the record disappears.

**SHA1 mismatch on upload is a silent reject.** The server drops the upload and returns nothing. The client will re-attempt on the next sync. Do not confuse SHA1 (used for upload verification) with SHA-256 (used for auth token computation and the dashboard token).

**`sync_done` is session-gated.** The server only sends `sync_done` when `wasPending && pendingUploads.size === 0`. A real-time `file_data` upload from a connected client outside of a sync cycle does not trigger `sync_done`. This prevents the client from thinking a sync session finished when none was in progress.

**`VersionCheckMsg.build` is a string, not a number.** The esbuild plugin stamps the build as `Date.now().toString()`. The server stores it as a string in `build_info.json`. String equality is used for comparison (`!==`), not numeric comparison.

**Plugin device ID is a stable UUID** generated once on first load via `crypto.randomUUID()` and persisted in plugin data. It identifies the device in the dashboard and in `db.devices`. Never generate a new one on reconnect.

**The `app` global is NOT used inside the plugin source.** All Obsidian API calls go through `this.plugin.app` (in XSync) or `this.xSync.plugin.app` (in XNotify). This avoids TypeScript errors from the ambient `app` global and makes the dependency graph explicit.

**esbuild `alias` for `@ionsync/protocol`** points directly at `packages/protocol/src/index.ts`. This means protocol changes are picked up immediately on the next dev build without running `tsc` in the protocol package first. The server still needs the protocol compiled (`npx tsc` in `packages/protocol`) when running tests with `tsx`.

**File content is always base64** on the wire, for both text and binary files. The plugin encodes with `Buffer.from(text).toString("base64")` and decodes with `Buffer.from(content, "base64").toString("utf-8")`. Binary files skip the UTF-8 step and go straight to `ArrayBuffer`.

**Version restore pushes to peers immediately.** `VersionHistoryModal` restores a file by writing it to the vault via `vault.adapter.write()`, then calls `xSync.pushFile(path)` to upload and broadcast to all connected peers right away. `pushFile` is a public wrapper around `_sendFileEvent` with `forceChanged: true`, bypassing the mtime-equality short-circuit that would otherwise skip unchanged files.

**`VersionHistoryModal` preview is text-only.** `_fetchVersionText` decodes content as UTF-8. Binary files (images, PDFs, audio) will display as garbled text or an empty string — there is currently no binary preview in the modal. If adding binary support, check the file extension before decoding and display a placeholder instead.

**Do not use `color-mix()` in `styles.css`.** Obsidian's Electron version does not support it — the rule silently fails and elements render unstyled. Use standard Obsidian CSS variables (`--background-secondary-alt`, `--background-modifier-hover`, `--background-modifier-border`, etc.) for all tinting and hover states.

---

## Test structure (`packages/server/test/`)

Tests use Node's built-in `node:test` runner with `tsx/esm` for TypeScript support. No vitest, no jest.

- `helpers.ts` — `startTestServer(overrides?)` creates a temp dir, real SyncDB, real Storage, and an HTTP server on a random port (`port: 0`). `connectClient(port)` returns a `TestClient` with a predicate-based `nextMsg()` inbox. Always call `srv.stop()` and `client.close()` in each test.
- `sync.test.ts` — 10 tests covering auth, sync, uploads, downloads, conflict resolution, and delete broadcast.
- `cleanup.test.ts` — 3 tests covering version pruning and deleted-file purge logic.

All test file content uses real SHA1 hashes (computed with `node -e "require('crypto').createHash('sha1').update(Buffer.from('...')).digest('hex')"`). Fake hashes like `"abc123"` will be rejected by the SHA1 verification in `handleFileUpload`.

Run the full suite:
```bash
cd packages/server
npm test
# Expected: 13 pass, 0 fail
```

---

## Adding a new message type

1. Add the interface to `packages/protocol/src/index.ts` and include it in the appropriate union (`ClientMsg` or `ServerMsg`).
2. Add a handler in `packages/server/src/ws/handlers/`.
3. Wire the new `msg.type` case in `packages/server/src/ws/server.ts`.
4. Add the send call in `packages/plugin/src/WsManager.ts` (if client-initiated) or `XSync.ts` (for handling incoming).
5. Add a test in `packages/server/test/sync.test.ts`.
6. Run `npm run typecheck` in both `packages/server` and `packages/plugin`.

## Modifying the DB schema

1. Add a new entry to the `MIGRATIONS` array in `packages/server/src/db/migrations.ts` with the next version number.
2. Add any new query methods to `SyncDB` in `packages/server/src/db/index.ts`.
3. **Never edit existing migration entries** — they are applied exactly once in production.
