# IonSync v2 — Sync Redesign Plan

Status: implemented · Date: 2026-06-15

## Status summary

- **Phase 0 — seq counter:** done, tested (migration v3, monotonic counter).
- **Phase 1 — cursor protocol + handler + rename tombstones:** done, tested.
- **Phase 2a — client hard switch to cursor + reconcile uploads:** done; in
  device testing. Plus resumable bootstrap (mid-stream cursor checkpoints,
  session-flagged pushes) and live-push prioritization over a sync backlog.
- **Phase 2b — IndexedDB index:** written but DORMANT behind `USE_INDEXEDDB =
  false` in `Storage.ts`. Activate (flip flag + wire `storage.close()` into
  `XSync.unload()`) and re-test on desktop + mobile when ready. Optimization
  only — not required for correctness.
- **Phase 3 — config stream:** the *goal* (no `.obsidian` flapping, workspace
  layout kept per-device) is already satisfied by existing code:
  `ExclusionFilter.dangerousFiles` hard-excludes `workspace.json`,
  `workspace-mobile.json`, `sync.json`, `graph.json`; config/dot-paths never
  mint conflict copies (server LWW + client skip); config uploads debounce at
  5s. A dedicated `configSince`/`configCursor` stream was deferred — build it
  only if per-device config profiles are needed.
- **Phase 4 — initial/full sync speedup:** delivered by the cursor work; no
  separate phase remaining.

## Goal

Make reconnect/full sync fast and stop `.obsidian` config files from flapping
into conflict copies. Root cause of both: every `XSync.sync()` does an
**O(total files)** full-tree scan + full-map diff, and config files are handled
as a special case inside the conflict gate rather than as their own stream.

Decisions locked in:
- **Clean redesign** of the sync path around a server-assigned sequence cursor.
- **IndexedDB** for the client device-state index (cross-platform, mobile-safe).
- Priorities: `.obsidian` conflict flapping + slow initial/full sync.

---

## Core idea: a monotonic revision cursor

Today the server compares the client's entire file map against
`db.getAllFiles()` on every sync. Replace that with a global, ever-incrementing
`seq` stamped on every change. Each device persists "I last saw seq N." On
reconnect it sends N; the server streams only `changes WHERE seq > N`.

Reconnect-sync goes from **O(total files)** to **O(changes since last sync)** —
a handful of records regardless of vault size. This is the single biggest lever.
It is also clock-independent (seq is server-assigned, never derived from mtime),
which keeps the existing `baseSha1` conflict gate valid.

---

## Phase 0 — Server: sequence counter (DB migration v3)

> Note: migration `version: 2` already exists (the `settings` table), so the
> seq migration is **version 3**.

- Add `seq INTEGER NOT NULL DEFAULT 0` to the `files` table; add index
  `idx_files_seq (seq)`; backfill existing rows in rowid order.
- A single **persistent** counter in `settings` (key `sync_seq`), allocated via
  an atomic `UPDATE ... RETURNING` inside each write transaction. Not `MAX(seq)`
  over `files` — `purgeDeletedFiles` hard-deletes rows, which would let a seq be
  reused and a client miss a change. `upsertFile()` (active writes *and* deleted
  tombstones), `repointFileRecord`, `restoreFile`, `restoreDeletedFiles`, and
  the two rename methods all stamp the next seq.
- New queries: `getChangesSince(seq, limit)` → `FileChange[]` ordered by
  `seq ASC`; `getCurrentSeq()` → current counter value.
- **Never edit past migrations** — add `version: 3` to the `MIGRATIONS` array.

> Known downstream gap (Phase 1/3): `renameFilePath` / hard deletes leave no
> tombstone at the old path, so the feed can't tell clients the old path is
> gone. The sync handler must derive that when it consumes the feed.

## Phase 1 — Protocol: cursor sync (new message types)

Add to `@ionsync/protocol` (and the `ClientMsg`/`ServerMsg` unions):

```
Client → Server: { type: "sync_cursor", since: <seq>, configSince: <seq> }
Server → Client: { type: "file_push", file, content }      // server-newer paths
             or:  { type: "file_event_result", path, result: "client_newer" }
Server → Client: { type: "sync_done", cursor: <newMaxSeq>, configCursor: <…> }
```

- `since: 0` = bootstrap (streams everything, reuse the existing 2,000-record
  chunking + UI yield).
- Client persists `cursor` only after `sync_done` (atomic — a dropped connection
  mid-stream just replays from the last committed cursor; idempotent because
  `decideUpload` already treats a matching head sha1 as an idempotent resend).
- Keep the old bulk `sync` message path alive behind a capability flag during
  rollout (see Migration) so a half-updated fleet still converges.

## Phase 2 — Client: IndexedDB index (replaces the metadata.json Map)

- New `IndexStore` wrapping IndexedDB (available in Obsidian's mobile webview):
  - object store `files`: `path → { mtime, sha1, seq, action, fileType }`
  - object store `meta`: `lastSyncedSeq`, `configCursor`, schema version
- `Storage` keeps an in-memory cache hydrated from IndexedDB on load; writes go
  through to IndexedDB. JSON `metadata.json` becomes a one-time import on upgrade.
- **Stop walking the tree on reconnect.** Normal operation is event-driven
  (vault `create`/`modify`/`delete`/`rename` → real-time `file_data`); the
  cursor handles anything missed while offline. Keep `computeTree()` only for
  (a) first-run bootstrap and (b) an occasional background drift reconciliation,
  not for every sync.

## Phase 3 — `.obsidian` as a first-class config stream

- Give config paths (`.obsidian/**`) their own cursor (`configSince`) and a
  strict **last-writer-wins, never-conflict-copy** policy. The dot-path special
  cases already in `decideUpload` and `_applyServerFile` get promoted to an
  explicit "config sync class" rather than scattered conditionals.
- **Exclude `workspace.json` / `workspace-mobile.json` by default** — they are
  device-specific pane layout and are the main source of flap. Add to
  `ExclusionFilter` as a dedicated default-on toggle.
- Debounce config uploads harder (these files rewrite on every focus change).
- Future option: per-device config profiles (official Sync's multi-profile
  model) — out of scope for v1 of this redesign.

## Phase 4 — Initial/full sync speedup

- Bootstrap streams via the seq feed in batches instead of a full map exchange.
- Before writing a pushed file, the client checks its local sha1 and skips
  identical content (content already addressed by sha1 server-side).
- Keep the existing "skip re-hash when stored mtime matches stat mtime"
  short-circuit — that already avoids re-hashing an unchanged vault.

---

## Migration / rollout

1. Server ships migration v3 (additive) and supports **both** the legacy `sync`
   message and the new `sync_cursor`.
2. Capability negotiation in `version_check`: client advertises `cursorSync: true`;
   server replies with whether it supports it. Old clients fall back to the
   legacy path automatically.
3. Client upgrade imports `metadata.json` → IndexedDB once, sets `lastSyncedSeq`
   to 0 so the first post-upgrade sync is a clean bootstrap against the seq feed.
4. Remove the legacy `sync` path only after the fleet has moved.

## Tests (extend `packages/server/test/sync.test.ts`)

- seq monotonicity: every upsert/delete strictly increases `MAX(seq)`.
- cursor delta: client with `since: N` receives only paths changed after N.
- bootstrap: `since: 0` streams the whole vault, batched.
- config LWW: rapid alternating `.obsidian/app.json` writes from two devices
  converge with **zero** conflict copies (regression test for June 2026 bug).
- `workspace.json` excluded by default.
- Real SHA1 hashes only (fakes are rejected by upload verification).

## Open risks

- IndexedDB quota on mobile for very large vaults — verify, but indexes are
  small (metadata only, not content).
- Cursor must survive a DB restore: it lives in SQLite, so a restored DB carries
  its `MAX(seq)`; clients with a higher stale cursor would under-fetch. Guard:
  if `client.since > server MAX(seq)`, server forces a bootstrap (`since: 0`).
- Ordering: seq assignment must happen inside the same transaction as the row
  write to avoid gaps/races under concurrent uploads.
