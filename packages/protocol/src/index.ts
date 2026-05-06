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

// ─── Client → Server messages ──────────────────────────────────────────────

export interface AuthMsg {
  type: "auth";
  deviceId: string;
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
}

/** Client requesting a file from the server (server_newer case). */
export interface FileDataRequestMsg {
  type: "file_data";
  mode: "send";
  path: string;
}

export interface FileHistoryRequestMsg {
  type: "file_history";
  path: string;
}

export type ClientMsg =
  | AuthMsg
  | VersionCheckMsg
  | SyncMsg
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
  /** client_newer → client should upload. server_newer → client should request download. null → no-op. */
  result: "client_newer" | "server_newer" | null;
}

/**
 * Server pushing a file to the client (proactive during sync, or live broadcast).
 * Content is base64-encoded.
 */
export interface FilePushMsg {
  type: "file_push";
  file: FileEntry;
  content: string;
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
