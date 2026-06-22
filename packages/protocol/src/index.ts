// ─── Shared domain types ───────────────────────────────────────────────────

export type FileAction = "active" | "deleted";
export type FileType = "file" | "folder";

export interface FileEntry {
  path: string;
  sha1: string;
  mtime: number; // milliseconds, client-reported — used for conflict resolution
  action: FileAction;
  fileType: FileType;
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

export interface FileHistoryRequestMsg {
  type: "file_history";
  path: string;
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

export type ClientMsg =
  | AuthMsg
  | VersionCheckMsg
  | SyncMsg
  | SyncCursorMsg
  | FileEventMsg
  | FileDataUploadMsg
  | FileDataRequestMsg
  | FileHistoryRequestMsg;

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
   * null → no-op.
   */
  result: "client_newer" | "server_newer" | "conflict" | null;
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

export interface VersionCheckResponseMsg {
  type: "version_check_response";
  needsUpdate: boolean;
  /** Populated only when needsUpdate=true. Keys are filenames, values are base64. */
  files?: Record<string, string>;
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

export type ServerMsg =
  | ChallengeMsg
  | AuthOkMsg
  | AuthErrorMsg
  | FileEventResultMsg
  | FilePushMsg
  | FileDataResponseMsg
  | FileHistoryResponseMsg
  | VersionCheckResponseMsg
  | SyncDoneMsg;

// ─── Helpers ───────────────────────────────────────────────────────────────

export function compareFiles(
  client: FileEntry,
  server: FileEntry
): "client_newer" | "server_newer" | null {
  if (client.sha1 === server.sha1 && client.action === server.action) return null;
  return client.mtime > server.mtime ? "client_newer" : "server_newer";
}