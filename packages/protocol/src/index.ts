// ─── Shared domain types ───────────────────────────────────────────────────

export type FileAction = "active" | "deleted";
export type FileType = "file" | "folder";

export interface FileEntry {
  path: string;
  sha1: string;
  mtime: number; // milliseconds, client-reported — used for conflict resolution
  action: FileAction;
  fileType: FileType;
  size?: number; // bytes; client-local change-detection aid (strengthens the mtime fast-path). Optional: absent on server-originated entries and older metadata.
} 

export interface VersionEntry {
  mtime: number;
  sha1: string;
  receivedAt: number; // server time
}

// ✅ Added for Phase 3: Mobile Background Sync (HTTP POST Payload)
export interface BackgroundSyncReq {
  deviceId: string;
  files: {
    file: FileEntry;
    content: string; // Base64
  }[];
}

// ─── Client → Server messages ──────────────────────────────────────────────

export interface AuthMsg {
  type: "auth";
  deviceId: string;
  /** Optional human-readable name from the plugin's settings. */
  deviceName?: string;
  /** SHA-256( nonce[0..16] + password + nonce[16..] ) — same formula as v1 */
  token: string;
}

export interface VersionCheckMsg {
  type: "version_check";
  version: string;
  build: string;
  /**
   * Capability tokens the *client* supports (e.g. "binary_frames"). Lets the
   * server feature-detect the client symmetrically to how the client reads the
   * server's `caps`. Absent on older clients → server assumes none and uses the
   * legacy base64-in-JSON wire for that peer.
   */
  caps?: string[];
}

export interface SyncMsg {
  type: "sync";
  files: FileEntry[];
  /**
   * True on the final chunk of a multi-chunk sync message.
   * Undefined is treated as true for backward compatibility with single-chunk clients.
   */
  last?: boolean;
}

/**
 * Single-file event — used for live sync (file changed while connected).
 * For initial bulk sync the client sends `sync` instead.
 */
export interface FileEventMsg {
  type: "file_event";
  file: FileEntry;
}

/** Client uploading a file to the server. Content is base64-encoded. */
export interface FileDataUploadMsg {
  type: "file_data";
  mode: "apply";
  file: FileEntry;
  /** base64-encoded file content; empty string for folders or deleted files */
  content: string;
  /**
   * Raw file bytes, present only on the binary-frame path (negotiated via the
   * "binary_frames" cap). When set, `content` is empty and the codec carries
   * these bytes out-of-band. Never JSON-serialized. See protocol/wire.ts.
   */
  contentBytes?: Uint8Array;
  /**
   * sha1 of the version this edit was based on — i.e. the sha1 the client last
   * synced for this path (from its stored metadata). Lets the server detect
   * concurrent edits without relying on client clocks:
   *   baseSha1 === server head  → fast-forward, accept.
   *   baseSha1 is an older known version → concurrent edit → conflict.
   * Omitted by legacy clients and on first sync → server falls back to
   * last-write-wins by mtime.
   */
  baseSha1?: string;
}

/** Client requesting a file from the server (server_newer case, or version restore). */
export interface FileDataRequestMsg {
  type: "file_data";
  mode: "send";
  path: string;
  /** Optional: request a specific stored version by its mtime. Omit for latest. */
  mtime?: number;
}

/**
 * Client preserving the LOSING side of a conflict. Instead of minting a
 * "(Conflicted Copy …)" file in the vault, the losing content is uploaded here
 * and stored server-side as a reviewable conflict record — the head is never
 * touched and nothing is broadcast. `file.path` is the original note; `file.sha1`
 * and `file.mtime` describe the losing content.
 */
export interface FileConflictMsg {
  type: "file_data";
  mode: "conflict";
  file: FileEntry;
  /** base64-encoded losing content (empty when contentBytes is used). */
  content: string;
  /** Raw losing bytes on the binary-frame path (see FileDataUploadMsg.contentBytes). */
  contentBytes?: Uint8Array;
}

export interface FileHistoryRequestMsg {
  type: "file_history";
  path: string;
}

// ─── Conflict management (client ↔ server) ──────────────────────────────────
// Lets a plugin review and act on the server-side conflict records (the losing
// sides of conflicts, stored instead of "(Conflicted Copy …)" files) without
// opening the web dashboard.

/** Ask for the list of unresolved conflicts. */
export interface ConflictListRequestMsg {
  type: "conflict_list";
}

/** Ask for the losing content of one conflict (base64; decrypt client-side). */
export interface ConflictContentRequestMsg {
  type: "conflict_content";
  id: number;
}

/** Dismiss a conflict (mark it resolved). The file head is untouched. */
export interface ConflictResolveMsg {
  type: "conflict_resolve";
  id: number;
}

/** Restore a conflict's losing content as the file's current head and broadcast it. */
export interface ConflictRestoreMsg {
  type: "conflict_restore";
  id: number;
}

/**
 * Client telling the server that a path was renamed/moved as a single atomic
 * operation. Sent instead of the legacy delete(from)+create(to) decomposition
 * so the server can (a) relink version history in one step and (b) detect a
 * *structural* conflict — a concurrent content edit of `from` on another device.
 *
 * Carries no content: for a pure move the server relinks the bytes it already
 * holds; if `sha1` differs from its head of `from` (an unsynced local edit
 * preceded the rename) the server pulls the new content via a normal
 * file_event_result{ result: "client_newer" } for `to`.
 */
export interface FileRenameMsg {
  type: "file_rename";
  from: string;
  to: string;
  /** sha1 of the content now at `to` (== head of `from` for a pure move). */
  sha1: string;
  /** client mtime of the file at `to`. */
  mtime: number;
  /** sha1 the client last synced for `from`. Mirrors FileDataUploadMsg.baseSha1:
   *  if it no longer matches the server head of `from`, the rename raced a
   *  concurrent edit → structural conflict. Omitted by first-sync/legacy. */
  baseSha1?: string;
  fileType: FileType;
}

/**
 * Cursor-based delta sync (sync redesign phase 1).
 *
 * Instead of sending its whole file list (`sync`), a client says "catch me up
 * since sequence N". The server replays every change with `seq > since` as
 * `file_push` messages (active files with content, deletions with empty
 * content), then `sync_done { cursor }`. The client persists `cursor` as its
 * new `since` for the next reconnect.
 *
 * This is the server→client (download) direction only. The client's own local
 * edits made while offline still flow up as ordinary real-time `file_data`
 * uploads — they are not part of the cursor exchange.
 */
export interface SyncCursorMsg {
  type: "sync_cursor";
  /** Highest server seq the client has already applied. 0 = full bootstrap. */
  since: number;
}

/**
 * Completeness audit (integrity safety net). After a cursor bootstrap a client
 * can ask the server for the sha1 of every file it currently considers ACTIVE.
 * The client diffs that manifest against its local vault and, for any path the
 * server has but the client is missing (or holds at a different sha1), requests
 * a targeted re-push via `verify_missing`. This closes the silent under-fetch
 * gap where a client's cursor outran what it actually holds on disk (the
 * 2026-08 incident): "sync complete" no longer means "cursor caught up", it
 * means "I actually have every active file the server has".
 */
export interface VerifyRequestMsg {
  type: "verify_request";
}

/**
 * Client → server: re-send these specific active paths (download-only repair).
 * Purely additive — it can only pull files DOWN, never delete, so a stale audit
 * can never remove data. Capped server-side.
 */
export interface VerifyMissingMsg {
  type: "verify_missing";
  paths: string[];
}

export type ClientMsg =
  | AuthMsg
  | VersionCheckMsg
  | SyncMsg
  | SyncCursorMsg
  | FileEventMsg
  | FileDataUploadMsg
  | FileDataRequestMsg
  | FileConflictMsg
  | FileHistoryRequestMsg
  | ConflictListRequestMsg
  | ConflictContentRequestMsg
  | ConflictResolveMsg
  | ConflictRestoreMsg
  | FileRenameMsg
  | VerifyRequestMsg
  | VerifyMissingMsg;

// ─── Server → Client messages ──────────────────────────────────────────────

export interface ChallengeMsg {
  type: "challenge";
  nonce: string;
}

export interface AuthOkMsg {
  type: "auth_ok";
}

export interface AuthErrorMsg {
  type: "auth_error";
  message: string;
}

/** Outcome of a single-file comparison. */
export interface FileEventResultMsg {
  type: "file_event_result";
  path: string;
  /**
   * client_newer → client should upload.
   * server_newer → client should request download.
   * conflict → upload was rejected as a concurrent edit; the server kept its
   *   version and stored the client's content as a "(Conflicted Copy …)" file,
   *   which is pushed to all peers (including the uploader). The server also
   *   pushes its current version of the original path back to the uploader.
   * structural_conflict → an upload/rename raced a rename of the same path on
   *   another device (the file was moved while this client edited it). The
   *   server completed the rename and preserved the concurrent edit as a
   *   "(Conflicted Copy …)" next to the rename target; `renamedTo` names that
   *   target so the client can reconcile without a full re-sync.
   * null → no-op.
   */
  result: "client_newer" | "server_newer" | "conflict" | "structural_conflict" | null;
  /** Present only when result === "structural_conflict": the path the surviving
   *  rename landed at. */
  renamedTo?: string;
}

/**
 * Server pushing a file to the client (proactive during sync, or live broadcast).
 * Content is base64-encoded.
 */
export interface FilePushMsg {
  type: "file_push";
  file: FileEntry;
  content: string;
  /**
   * Raw file bytes, present only on the binary-frame path (negotiated via the
   * "binary_frames" cap). When set, `content` is empty and the codec carries
   * these bytes out-of-band. Never JSON-serialized. See protocol/wire.ts.
   */
  contentBytes?: Uint8Array;
  /**
   * The server sequence number at which this change was recorded. Present on
   * cursor-sync pushes and live broadcasts (phase 1). Clients should advance
   * their stored cursor to the highest `seq` they have applied, so a live push
   * that arrives mid-session is not missed on the next reconnect. Omitted by
   * the legacy `sync` push path.
   */
  seq?: number;
  /**
   * True only for pushes that are part of an in-order cursor-sync session (the
   * server replaying `getChangesSince`). Live broadcasts omit it. The client
   * uses this to checkpoint its cursor only from the ordered stream: a live edge
   * arriving mid-session has a higher seq and must not advance the checkpoint,
   * or an interrupted bootstrap would skip the un-applied middle. (phase 2a+)
   */
  session?: boolean;
}

/** Server responding to a `file_data mode:"send"` download request. */
export interface FileDataResponseMsg {
  type: "file_data_response";
  file: FileEntry;
  content: string;
}

export interface FileHistoryResponseMsg {
  type: "file_history_response";
  path: string;
  versions: VersionEntry[];
}

/** One unresolved conflict, as surfaced to a client for review. */
export interface ConflictSummary {
  id: number;
  path: string;
  sha1: string;
  mtime: number;
  /** Human-readable name of the device that produced the losing edit, if known. */
  deviceName: string | null;
  createdAt: number;
}

export interface ConflictListResponseMsg {
  type: "conflict_list_response";
  conflicts: ConflictSummary[];
}

export interface ConflictContentResponseMsg {
  type: "conflict_content_response";
  id: number;
  path: string;
  /** base64 losing content (may be E2EE ciphertext — see `encrypted`). */
  content: string;
  encrypted: boolean;
  found: boolean;
}

export interface ConflictActionResponseMsg {
  type: "conflict_action_response";
  id: number;
  action: "resolve" | "restore";
  ok: boolean;
  path?: string;
  error?: string;
}

export interface VersionCheckResponseMsg {
  type: "version_check_response";
  needsUpdate: boolean;
  /** Populated only when needsUpdate=true. Keys are filenames, values are base64. */
  files?: Record<string, string>;
  /**
   * Optional server capability tokens (e.g. "file_rename"). Absent on older
   * servers → the client must assume the capability is unavailable and fall
   * back. Lets new clients feature-detect without a version-number handshake.
   */
  caps?: string[];
}

/** Sent when all pending sync transfers for a session have resolved. */
export interface SyncDoneMsg {
  type: "sync_done";
  /**
   * Present for cursor sync (phase 1): the seq the client is now caught up to.
   * The client persists this as its `since` for the next reconnect. Omitted by
   * the legacy `sync` path.
   */
  cursor?: number;
  /**
   * True when this was a bounded batch and more changes remain. The client
   * should immediately send another `sync_cursor { since: cursor }` to continue.
   * This keeps only one batch of file content in flight during a large bootstrap
   * (memory bound on low-RAM devices). Absent/false = fully caught up.
   */
  more?: boolean;
}

/**
 * Server asking an already-connected client to run a fresh sync cycle.
 *
 * Used by the dashboard's "Sync" button (`/api/action/trigger-sync/:peerId`).
 * That endpoint previously sent a bare `sync_done`, which the client just
 * files as "nothing pending" bookkeeping (see SyncDoneMsg) rather than
 * actually reconciling — so admin-triggered changes (e.g. a dashboard file
 * delete) never reached an already-connected client until it reconnected.
 * `request_sync` tells the client to call its normal `sync()` cycle (cursor
 * catch-up from its last-known seq), which picks up anything that changed
 * server-side since then.
 */
export interface RequestSyncMsg {
  type: "request_sync";
}

/**
 * Server → client: one bounded chunk of the active-file manifest (path + sha1).
 * Streamed in chunks like `sync`; `last:true` marks the final chunk. The client
 * accumulates all chunks, then diffs against its local vault. Only sha1 is sent
 * (not content), so even a huge vault's manifest is a few hundred KB.
 */
export interface VerifyManifestMsg {
  type: "verify_manifest";
  files: { path: string; sha1: string }[];
  last: boolean;
}

export type ServerMsg =
  | ChallengeMsg
  | AuthOkMsg
  | AuthErrorMsg
  | FileEventResultMsg
  | FilePushMsg
  | FileDataResponseMsg
  | FileHistoryResponseMsg
  | ConflictListResponseMsg
  | ConflictContentResponseMsg
  | ConflictActionResponseMsg
  | VersionCheckResponseMsg
  | SyncDoneMsg
  | RequestSyncMsg
  | VerifyManifestMsg;

// ─── Helpers ───────────────────────────────────────────────────────────────

export function compareFiles(
  client: FileEntry,
  server: FileEntry
): "client_newer" | "server_newer" | null {
  if (client.sha1 === server.sha1 && client.action === server.action) return null;
  return client.mtime > server.mtime ? "client_newer" : "server_newer";
}

/**
 * Return the paths of every currently-active file recorded under `folderPath`.
 *
 * Used to cascade a folder deletion into per-file deletes: Obsidian does not
 * reliably emit an individual "delete" vault event for each nested file when a
 * folder is removed, and the sync protocol only propagates per-file deletes
 * (folder-type deletes are ignored on apply). Without this, a deleted folder's
 * children stay "active" on the server and are re-pushed to every other device.
 *
 * The trailing "/" on the prefix is essential: it ensures a plain file delete
 * (e.g. "notes/foo.md") never matches sibling paths, so callers can safely run
 * this on every delete event — only real folders yield children. Already-deleted
 * entries are skipped so a re-delete is a no-op.
 */
export function collectFolderChildren(
  folderPath: string,
  files: Record<string, FileEntry>
): string[] {
  const prefix = folderPath + "/";
  const out: string[] = [];
  for (const p of Object.keys(files)) {
    if (p.startsWith(prefix) && files[p]?.action !== "deleted") out.push(p);
  }
  return out;
}

/** Absolute ceiling on how many deletes a single folder-delete event may cascade. */
export const CASCADE_HARD_CAP = 1000;
/** ...or this fraction of the whole vault, whichever is smaller. */
export const CASCADE_VAULT_FRACTION = 0.33;

/**
 * True when cascading a folder delete would remove an implausibly large number
 * of files — over the hard cap OR over a third of the entire vault. A single
 * folder-delete event must never be able to wipe a knowledge base: a spurious or
 * mistaken removal (or a Windows 8.3 short-name path collision) once cascaded
 * ~14k deletes across every device. When this returns true the caller refuses to
 * propagate the deletion automatically and warns the user; the other devices and
 * the server keep the files, so nothing is lost. Real bulk deletes go in smaller
 * batches or through the dashboard's explicit folder-delete.
 */
export function cascadeDeleteExceedsSafetyCap(childCount: number, vaultSize: number): boolean {
  if (childCount > CASCADE_HARD_CAP) return true;
  if (vaultSize > 0 && childCount > vaultSize * CASCADE_VAULT_FRACTION) return true;
  return false;
}

/**
 * Offline-delete reconciliation (sync-audit gap S4). Given the device's synced
 * metadata and the set of paths actually present on disk *after a fully drained
 * download*, return the active files that were deleted while this device was
 * offline: present in metadata as an active file, absent from disk, and not
 * excluded (config / .obsidian). Such deletes never flow through live vault
 * events, so without propagating them the server keeps the files active and
 * resurrects them on the next reconnect.
 *
 * Pure and conservative by construction:
 *  - Returns only a SUBSET of `metadata` keys — it can never invent a path.
 *  - Returns [] when `onDiskPaths` is empty: an empty snapshot means the scan
 *    did not run or the vault is unavailable, never "delete everything".
 * The caller must still gate the result through `cascadeDeleteExceedsSafetyCap`
 * (so an unmounted vault cannot mass-delete) and re-stat each path before it
 * sends the delete (a transiently-evicted file may reappear on disk).
 */
export function computeOfflineDeletes(
  metadata: Record<string, Pick<FileEntry, "action" | "fileType" | "sha1"> | undefined>,
  onDiskPaths: ReadonlySet<string>,
  isExcluded: (path: string) => boolean = () => false
): string[] {
  if (onDiskPaths.size === 0) return [];
  const missing: string[] = [];
  for (const [path, meta] of Object.entries(metadata)) {
    if (!meta || meta.action !== "active" || meta.fileType !== "file") continue;
    if (onDiskPaths.has(path)) continue;
    if (isExcluded(path)) continue;
    missing.push(path);
  }
  return missing;
}

// ─── Binary-frame wire codec ────────────────────────────────────────────────
export { encodeFrame, decodeFrame, canBinaryFrame, BINARY_FRAMES_CAP } from "./wire.js";