# Design: Explicit Rename Operation & Structural Conflict Detection

Status: **proposal** (no code yet). Target: `packages/protocol`, `packages/server`, `packages/plugin`.

This document specs the one genuinely-new item from the sync-hardening discussion:
distinguishing a **structural conflict** (one device renamed/moved a file while
another edited its content) from an **actual conflict** (two devices edited the
same content). Actual conflicts are already handled by the `baseSha1` upload gate
in `handlers/fileData.ts`; this doc does not touch that path except where the two
interact.

---

## 1. The problem

### Current rename flow

A rename is never transmitted as a rename. In `XSync.ts` (the `action === "rename"`
branch, ~line 912) the plugin decomposes it:

1. Queue `oldPath` into `deleteQueue` (stamped `mtime = Date.now()`), then
   `_processDeleteQueue()` → server receives a **delete** for `oldPath`.
2. `_processLocalEvent("create", newFile, true)` → server receives an
   **upload** for `newPath`.

The server sees two uncorrelated events. It has no idea they are one operation.

### Why that loses data

Take device **A** renames `X → Y` (its last-synced sha of `X` is `S0`), while
device **B** concurrently edits `X`'s content to `S2`. Because the two halves of
A's rename hit the server as independent messages, the outcome is **order-dependent**:

- **Order 1 — rename lands first.** Server deletes `X`, creates `Y` (content `S0`).
  Then B's upload for `X` arrives with `baseSha1 = S0`. `decideUpload` hits the
  `serverFile.action === "deleted" → accept` branch (line 27) and **resurrects
  `X`** with B's `S2`. Final state: `X` (B's edit) **and** `Y` (A's copy) both
  exist. A's rename intent is silently undone from B's perspective; the vault now
  has a duplicate. No conflict copy, no notification.
- **Order 2 — B's edit lands first.** Server head of `X` becomes `S2`. Then the
  delete half of A's rename arrives and deletes `X` — **destroying B's `S2` edit
  down into version history** — and `Y` is created from `S0`. B's edit is gone
  from every vault's live tree.

Both outcomes violate IonSync's stated invariant: *"No edit is ever silently
relegated to version history"* (CLAUDE.md, conflict-resolution section). The root
cause is that the server can't see the rename as an atomic op, so it can't detect
that `X` was concurrently edited.

---

## 2. Rejected alternative: heuristic delete+create correlation

The tempting cheap fix is to *infer* renames server-side: when a delete of `X`
and a create of `Y` arrive close together with the same content hash, treat them
as a rename. Rejected because it is unreliable in exactly the cases that matter:

- **A local edit before the rename** (user edits `X` while offline/debounced,
  then renames `X→Y`) makes the create's sha1 ≠ the deleted file's sha1, so a
  hash-matching correlator can't pair the two halves.
- **Two identical-content files** renamed in the same window (common with
  templated notes or empty files) are indistinguishable — the correlator pairs
  the wrong delete with the wrong create.
- **Cross-session splits.** The delete may flush from `deleteQueue` on one
  connection and the create arrive on the next reconnect; a time-window heuristic
  never fires.
- **Folder renames** emit many child events; correlating N deletes to N creates
  by content is O(N²) guesswork.

An explicit, correlated rename message removes all of this ambiguity. The plugin
already *knows* it's a rename at the source (it has `oldPath` in hand); we should
carry that fact over the wire instead of throwing it away and reconstructing it.

---

## 3. Protocol changes (`packages/protocol/src/index.ts`)

### 3.1 New client → server message

```typescript
export interface FileRenameMsg {
  type: "file_rename";
  from: string;              // old vault path
  to: string;                // new vault path
  /** sha1 of the file's content at the new path (== old content for a pure
   *  rename; differs when the user renamed AND edited in one action). */
  sha1: string;
  mtime: number;             // client mtime of the file at `to`
  /** sha1 the client last synced for `from` (its stored metadata for the old
   *  path). Drives structural-conflict detection, mirroring baseSha1 on uploads. */
  baseSha1?: string;
  fileType: FileType;        // "file" | "folder"
}
```

Add to the `ClientMsg` union. **No content field.** The rename references content
by hash; the server supplies it (relink) or requests it (see §4), which keeps a
folder rename or a rename of a large binary from re-uploading megabytes.

### 3.2 Extend the result union

`FileEventResultMsg.result` gains one member, plus an optional discriminator so
the client can react precisely:

```typescript
result: "client_newer" | "server_newer" | "conflict" | "structural_conflict" | null;
/** Present when result === "structural_conflict": where the surviving rename
 *  landed, so the client can reconcile its local tree without a full re-sync. */
renamedTo?: string;
```

`"conflict"` keeps its exact current meaning (content-vs-content). Adding a new
enum member rather than overloading `"conflict"` means the existing plugin
conflict handler needs no behavioral change for the content case.

### 3.3 Backward compatibility

Peers that *receive* the result of a rename are unaffected: the server still
broadcasts a `file_push` delete for `from` and a `file_push` create for `to`
(§4), which is byte-for-byte what they see today. Only the **initiating** client
and the **server** need to understand `file_rename`. A legacy plugin that never
sends `file_rename` keeps working via the old delete+create path — so this is a
plugin-version-gated send (see §6), not a flag day.

---

## 4. Server handler (`packages/server/src/ws/handlers/rename.ts`)

Wire a `case "file_rename"` in `ws/server.ts` to `handleRename(ctx, peer, msg)`.
The handler runs one decision, analogous to `decideUpload`:

```
serverFrom = db.getFile(from)

1. from missing OR already deleted-by-rename to `to` with head sha1 == msg.sha1
      → idempotent no-op (retry / replay). Send nothing new, advance queue.

2. from active, and (baseSha1 absent OR baseSha1 == serverFrom.sha1)
      → CLEAN RENAME (no concurrent edit on `from`):
        a. If msg.sha1 == serverFrom.sha1  → pure rename, no content changed:
             relink — copy version history from `from` to `to`, write head at
             `to`, mark `from` deleted (with rename tombstone, §5).
        b. If msg.sha1 != serverFrom.sha1  → rename + edit:
             we don't have `to`'s new bytes. Reply
             file_event_result{ path: to, result: "client_newer" } to pull the
             upload, and pre-record the rename tombstone on `from` so the
             follow-up apply for `to` is accepted and `from` is retired.

3. from active, baseSha1 present, baseSha1 != serverFrom.sha1
      → STRUCTURAL CONFLICT (someone edited `from` since the client last synced):
        - Complete the rename to `to` from A's content (relink or pull as in 2).
        - PRESERVE the concurrent edit: leave serverFrom's current head in place
          as a surviving file. Because `from` is being retired, re-materialize it
          as a "(Conflicted Copy …)" of `to` so the two divergent intents both
          land next to each other, OR keep it at `from` if `from` still has a
          live head. (Deterministic rule below.)
        - Reply file_event_result{ path: from, result: "structural_conflict",
          renamedTo: to } to the initiator and re-push heads so it converges.
```

### Deterministic resolution rule (the important part)

The rule must be a pure function of server state so both arrival orders converge
to the **same** final tree:

> **Rename always completes to `to`. The concurrent edit of `from` is never
> destroyed: it is preserved as `to`'s conflicted copy.** Config/dot-paths are
> exempt (LWW, no copy), exactly as in `decideUpload`.

Walk both orders for A renames `X→Y` (base `S0`), B edits `X`→`S2`:

- **rename first:** `Y` created (`S0`), `X` tombstoned→`Y`. B's later upload for
  `X` carries `baseSha1 = S0`. The tombstone tells the server `X` was renamed, so
  instead of the current resurrect-on-deleted branch, the upload is diverted to
  `Y (Conflicted Copy … B).md` with B's `S2`. **Final: `Y`=S0, `Y (Conflicted
  Copy)`=S2.**
- **edit first:** `X` head becomes `S2`. Rename arrives, `baseSha1 S0 != S2` →
  structural conflict. `Y` created from A's content; `X`'s `S2` head preserved as
  `Y (Conflicted Copy … B).md`; `X` tombstoned. **Final: `Y`=S0, `Y (Conflicted
  Copy)`=S2.** ✅ identical.

This reuses `conflictCopyPath()` and the `applyConflict` broadcast machinery
already in `fileData.ts` — the conflict-copy naming, the peer push, and the
"re-push head to uploader" convergence step are all in place.

---

## 5. DB change (`migrations.ts` v4, `db/index.ts`)

**Most of this layer already exists.** `db/index.ts` has `renameFilePath(from,
to)`, `renameFolderPaths(fromPrefix, toPrefix)`, and the shared
`renameOneInternal(from, to, now)` — they repoint `to` as active with a fresh
seq, move version history, and leave `from` as a `deleted` tombstone (also with a
fresh seq, so both surface in the cursor feed). This is covered by
`test/seq.test.ts` ("renameFilePath tombstones the old path…"). **But today these
are called only from the dashboard HTTP routes** (`http/routes.ts` 731/755) —
admin-initiated renames — never from a client sync message. And the tombstone is
a *plain* `deleted` row: it does **not** record where the file went, so a later
upload to the old path can't tell rename from delete. Two gaps to close:

1. **Structural-conflict metadata.** Add one nullable column — do **not** edit
   v1–v3:

   ```typescript
   {
     version: 4,
     up(db) {
       // When a file is retired by a rename (not a plain delete), record where
       // it went. A later upload whose baseSha1 matches the pre-rename head is
       // then recognized as an edit-to-a-renamed-file (structural conflict)
       // instead of resurrecting the old path.
       db.exec(`ALTER TABLE files ADD COLUMN renamed_to TEXT;`);
     },
   }
   ```

   Then set `renamed_to = toPath` on the tombstone inside `renameOneInternal`
   (one extra column in its existing tombstone UPDATE — no new method needed),
   and add `getRenameTarget(path): string | null`. `action` stays `"deleted"` so
   existing delete-propagation and cleanup keep working unchanged.

2. **Reuse, don't duplicate.** The `file_rename` handler (§4) calls the existing
   `renameFilePath` / `renameFolderPaths`; the seq-bump-for-both-sides behavior
   cursor clients need is already in `renameOneInternal` (`allocateSeq`). No new
   rename method.

- `decideUpload` gains one branch **before** the `serverFile.action === "deleted"
  → accept` line (fileData.ts:27): if the deleted record has `renamed_to` set and
  the upload's `baseSha1` matches a known pre-rename version, return a new
  `"structural_conflict"` decision routed through `applyConflict` against the
  rename target. This is the only edit to the existing gate.

---

## 6. Plugin change (`packages/plugin/src/XSync.ts`)

Replace the decompose-into-delete+create body of the `action === "rename"` branch
(~line 912) with a single correlated send, gated on server capability:

```typescript
if (action === "rename") {
  const oldPath = args[0] as string;
  const oldMeta = this.storage.readMetadata(oldPath);
  const stat = await this.plugin.app.vault.adapter.stat(file.path);
  // Hash current content the same way Storage.computeTree does — via the
  // Utils.getSHA / getSHABinary helpers (there is no storage.computeSha).
  // For a pure move newSha1 === oldMeta.sha1; it differs only if an unsynced
  // local edit preceded the rename.
  const txt = await this.plugin.app.vault.adapter.read(file.path);
  const newSha1 = await Utils.getSHA(txt);
  this.ws.send({
    type: "file_rename",
    from: oldPath,
    to: file.path,
    sha1: newSha1,
    mtime: stat?.mtime ?? Date.now(),
    baseSha1: oldMeta?.sha1,
    fileType: "file",
  });
  // update local metadata: drop oldPath, record newPath
  return;
}
```

- **Capability gate.** Keep the current delete+create path as a fallback when the
  connected server predates `file_rename`. Simplest signal: extend the existing
  `version_check_response` handling so the plugin records server support and only
  emits `file_rename` when present; otherwise fall through to today's code. (No
  new negotiation round-trip — reuse version_check.)
- **Receiving** a rename needs no new client message: the server still delivers a
  delete `file_push` for `from` and a create `file_push` for `to`, handled by the
  existing `_applyServerFile`. The initiator additionally handles
  `structural_conflict` in its `file_event_result` listener (surface a notice;
  the conflicted copy arrives as a normal push).
- Folder rename: Obsidian fires a rename for the folder and for each child. Send
  `file_rename` per file event as above; a folder-level rename with
  `fileType: "folder"` carries no content and just relinks the prefix. Spec note:
  confirm Obsidian's child-event behavior on the target platforms before relying
  on per-child events vs. expanding the prefix server-side.

---

## 7. E2EE interaction

`file_rename` carries the plaintext `sha1` (same as uploads today), which the
server cannot verify for encrypted vaults — fine, because a pure rename **relinks
existing stored ciphertext by path**, never re-hashing content. The rename+edit
case (§4.2b) pulls a normal `file_data` upload for `to`, which flows through the
existing E2EE detection and `purgeUnencryptedVersions` path unchanged.

---

## 8. Tests (`packages/server/test/sync.test.ts`)

Add, using the existing `startTestServer` / `connectClient` harness and **real
SHA1s**:

1. **Pure rename** — A uploads `X`, renames `X→Y`; assert `Y` active with X's
   content, `X` deleted with `renamed_to = "Y"`, history relinked, peer B gets
   delete `X` + push `Y`.
2. **Rename + edit** — rename where `sha1 != head`; assert server requests upload
   for `to`, then accepts and retires `from`.
3. **Structural conflict, rename-first** — rename `X→Y`, then B uploads `X`
   (`baseSha1 = S0`); assert no resurrection of `X`, B's content lands as
   `Y (Conflicted Copy …)`, B receives `structural_conflict`.
4. **Structural conflict, edit-first** — B uploads `X`=S2, then A renames `X→Y`
   (`baseSha1 = S0`); assert identical final tree to test 3 (order-independence).
5. **Idempotent replay** — same `file_rename` sent twice → second is a no-op.
6. **Config/dot-path rename** — `.obsidian/x → .obsidian/y` never mints a
   conflict copy (LWW carve-out holds).

Run natively on Windows via `npm test` (per CLAUDE.md's sandbox caveat — the
sqlite native module is a Windows build). Expected new total: 17 → 23 pass.

---

## 9. Work breakdown & order

1. Protocol: add `FileRenameMsg`, extend result union (`protocol/src/index.ts`);
   `npx tsc` in `packages/protocol`.
2. DB: migration v4 (`renamed_to` column) + set it in the existing
   `renameOneInternal` tombstone UPDATE + `getRenameTarget` (`db/`). Reuse the
   existing `renameFilePath` / `renameFolderPaths`.
3. Server: `handlers/rename.ts`, one branch in `decideUpload`, wire `ws/server.ts`.
4. Tests 1–6 green.
5. Plugin: capability-gated `file_rename` send + `structural_conflict` handling;
   `npm run typecheck` in `packages/plugin`.
6. Update CLAUDE.md conflict-resolution section to document structural conflicts.

Each step is a commit; steps 1–4 are server-only and shippable before the plugin
change (old plugins keep using delete+create). Per the repo's GitHub-first
policy, commit after each green step and push.

---

## 10. Open questions for you

- **Conflicted-copy placement.** The rule above lands the concurrent edit as
  `Y (Conflicted Copy …)`. Alternative: keep it at the original path `X` (as a
  resurrected file) so the edit stays where B was working. `Y`-adjacent keeps the
  two intents visually together; `X`-placement matches B's mental model. Pick one
  — it changes step 4's resolution branch.
- **Folder-rename granularity.** Per-child `file_rename` events (simpler server,
  more messages) vs. a single folder `file_rename` with server-side prefix
  expansion (fewer messages, more server logic). I lean per-child to reuse the
  file path wholesale.
