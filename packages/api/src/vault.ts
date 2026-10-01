/**
 * Headless IonSync client for the LLM API.
 *
 * Connects to the sync server as an ordinary device, keeps an in-memory,
 * DECRYPTED mirror of the vault's text notes, and turns API writes into the
 * same uploads/renames/deletes the Obsidian plugin sends — so every change goes
 * through the server's conflict gate, version history and live broadcast.
 *
 * Plaintext lives only in this process's memory; nothing is written to disk.
 */
import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import { encodeFrame, decodeFrame, BINARY_FRAMES_CAP } from "@ionsync/protocol";
import type {
  ClientMsg,
  ServerMsg,
  FileEntry,
  FilePushMsg,
  FileEventResultMsg,
  FileHistoryResponseMsg,
  FileDataResponseMsg,
  VersionEntry,
} from "@ionsync/protocol";
import type { ApiConfig } from "./config.js";
import { E2ee, blobVersion } from "./e2ee.js";
import { ApiError } from "./errors.js";
import { isHiddenPath, isTextPath } from "./paths.js";
import { applyEdits, type EditOp } from "./edits.js";

export interface Note {
  path: string;
  sha1: string;
  mtime: number;
  /** Plaintext size in bytes (0 for content the server did not send). */
  size: number;
  /** "text": readable. "binary": an attachment. "unreadable": see `reason`. */
  kind: "text" | "binary" | "unreadable";
  text: string | null;
  reason?: string;
}

const EMPTY_SHA1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
const REQUEST_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 90_000; // server pings every 30s

interface Waiter {
  match: (m: ServerMsg) => boolean;
  resolve: (m: ServerMsg) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export function sha1Hex(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

export class Vault {
  readonly notes = new Map<string, Note>();
  /** Authenticated and past the version handshake. */
  connected = false;
  /** True once the mirror has fully caught up at least once. */
  synced = false;
  lastError: string | null = null;

  private ws: WebSocket | null = null;
  private caps: string[] = [];
  private cursor = 0;
  private sessionActive = false;
  private stopped = false;
  private backoff = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly waiters: Waiter[] = [];
  private readonly results = new Map<string, FileEventResultMsg>();
  private readonly syncWaiters: Array<() => void> = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly e2ee: E2ee | null;
  private seenVersion: number | null = null;
  private deleteTimes: number[] = [];

  constructor(private readonly cfg: ApiConfig) {
    this.e2ee = cfg.e2eePassword ? new E2ee(cfg.e2eePassword) : null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.reconnectTimer = null;
    this.heartbeat = null;
    this.failWaiters(new ApiError(503, "shutting_down", "The API is shutting down."));
    this.ws?.terminate();
    this.ws = null;
    this.connected = false;
  }

  /** Resolves once the mirror is caught up; rejects after `timeoutMs`. */
  whenSynced(timeoutMs = 30_000): Promise<void> {
    if (this.synced) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for the first sync")), timeoutMs);
      this.syncWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.cfg.serverUrl, { maxPayload: 64 * 1024 * 1024 });
    this.ws = ws;
    this.caps = [];

    ws.on("open", () => this.beat());
    ws.on("ping", () => this.beat());
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      this.beat();
      let msg: ServerMsg;
      try {
        msg = decodeFrame(
          isBinary ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : raw.toString()
        ) as ServerMsg;
      } catch {
        return;
      }
      try {
        this.handle(msg);
      } catch (err) {
        this.cfg.log(`[vault] error handling ${msg.type}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    ws.on("error", (err: Error) => { this.lastError = err.message; });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      const was = this.connected;
      this.ws = null;
      this.connected = false;
      this.sessionActive = false;
      if (this.heartbeat) clearTimeout(this.heartbeat);
      this.failWaiters(new ApiError(503, "disconnected", "Lost the connection to the sync server; try again shortly."));
      if (this.stopped) return;
      if (was) this.cfg.log("[vault] disconnected from sync server — reconnecting");
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
  }

  /** Any traffic proves the socket is alive; silence past the window kills it. */
  private beat(): void {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.heartbeat = setTimeout(() => this.ws?.terminate(), HEARTBEAT_MS);
  }

  private send(msg: ClientMsg): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) {
      throw new ApiError(503, "disconnected", "Not connected to the sync server; try again shortly.");
    }
    ws.send(encodeFrame(msg, this.caps.includes(BINARY_FRAMES_CAP)));
  }

  // ── Incoming messages ─────────────────────────────────────────────────────

  private handle(msg: ServerMsg): void {
    switch (msg.type) {
      case "challenge": {
        const n = msg.nonce;
        const token = createHash("sha256")
          .update(n.slice(0, 16) + this.cfg.password + n.slice(16))
          .digest("hex");
        this.send({ type: "auth", deviceId: this.cfg.deviceId, deviceName: this.cfg.deviceName, token });
        break;
      }
      case "auth_error":
        this.lastError = `sync server rejected the login: ${msg.message}`;
        this.cfg.log(`[vault] ${this.lastError}`);
        this.backoff = 30_000; // don't hammer the server's auth rate limiter
        break;
      case "auth_ok":
        if (msg.e2eeSalt) this.e2ee?.setInstallSalt(msg.e2eeSalt);
        // The plugin-update payload a mismatched build triggers is ignored.
        this.send({ type: "version_check", version: "llm-api", build: "0", caps: [BINARY_FRAMES_CAP] });
        break;
      case "version_check_response":
        this.caps = msg.caps ?? [];
        this.connected = true;
        this.lastError = null;
        this.backoff = 1000;
        this.startSession();
        break;
      case "request_sync":
        if (!this.sessionActive) this.startSession();
        break;
      case "file_push":
        this.applyPush(msg);
        break;
      case "sync_done":
        if (msg.cursor !== undefined) this.cursor = msg.cursor;
        if (msg.more) {
          this.send({ type: "sync_cursor", since: this.cursor });
          break;
        }
        this.sessionActive = false;
        if (!this.synced) {
          this.synced = true;
          this.cfg.log(`[vault] mirror ready: ${this.notes.size} file(s), cursor ${this.cursor}`);
        }
        for (const w of this.syncWaiters.splice(0)) w();
        break;
      case "file_event_result":
        this.results.set(msg.path, msg);
        break;
      default:
        break;
    }
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i]!;
      if (w.match(msg)) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve(msg);
        break;
      }
    }
  }

  private startSession(): void {
    this.sessionActive = true;
    this.send({ type: "sync_cursor", since: this.cursor });
  }

  private applyPush(msg: FilePushMsg): void {
    const f = msg.file;
    // Only a live push outside a session may advance the cursor: mid-session it
    // would skip the not-yet-applied middle of an interrupted catch-up.
    if (msg.seq !== undefined && !msg.session && !this.sessionActive && msg.seq > this.cursor) {
      this.cursor = msg.seq;
    }
    if (f.fileType !== "file" || isHiddenPath(f.path)) return;
    if (f.action === "deleted") {
      this.notes.delete(f.path);
      return;
    }
    const bytes =
      msg.contentBytes && msg.contentBytes.length > 0
        ? msg.contentBytes
        : msg.content
          ? Buffer.from(msg.content, "base64")
          : null;
    this.notes.set(f.path, this.toNote(f, bytes));
  }

  /** Build a mirror entry from a server file entry and its (maybe encrypted) bytes. */
  private toNote(f: FileEntry, bytes: Uint8Array | null): Note {
    const base = { path: f.path, sha1: f.sha1, mtime: f.mtime };
    if (!isTextPath(f.path)) {
      return { ...base, size: bytes?.length ?? 0, kind: "binary", text: null };
    }
    if (!bytes) {
      if (f.sha1 === EMPTY_SHA1 || f.sha1 === "") return { ...base, size: 0, kind: "text", text: "" };
      return { ...base, size: 0, kind: "unreadable", text: null, reason: "The sync server did not send this file's content (it may exceed the server's size limit)." };
    }
    let plain: Uint8Array = bytes;
    const version = blobVersion(bytes);
    if (version !== null) {
      if (!this.e2ee) {
        return { ...base, size: 0, kind: "unreadable", text: null, reason: "This note is end-to-end encrypted and the API has no encryption password (IONSYNC_E2EE_PASSWORD)." };
      }
      try {
        plain = this.e2ee.decrypt(bytes);
      } catch {
        return { ...base, size: 0, kind: "unreadable", text: null, reason: "Decryption failed — the API's encryption password does not match this note." };
      }
      if (this.seenVersion === null || version > this.seenVersion) this.seenVersion = version;
    }
    return { ...base, size: plain.length, kind: "text", text: Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength).toString("utf8") };
  }

  // ── Request/response plumbing ─────────────────────────────────────────────

  private waitFor<T extends ServerMsg>(match: (m: ServerMsg) => boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(new ApiError(504, "sync_timeout", "The sync server did not confirm the change in time. Re-read the note to see whether it landed."));
      }, REQUEST_TIMEOUT_MS);
      this.waiters.push({ match, resolve: resolve as (m: ServerMsg) => void, reject, timer });
    });
  }

  private failWaiters(err: Error): void {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private async history(path: string): Promise<VersionEntry[]> {
    const wait = this.waitFor<FileHistoryResponseMsg>((m) => m.type === "file_history_response" && m.path === path);
    try {
      this.send({ type: "file_history", path });
    } catch (err) {
      wait.catch(() => undefined);
      this.failWaiters(err as Error);
      throw err;
    }
    return (await wait).versions;
  }

  private async fetchHead(path: string): Promise<FileDataResponseMsg> {
    const wait = this.waitFor<FileDataResponseMsg>((m) => m.type === "file_data_response" && m.file.path === path);
    try {
      this.send({ type: "file_data", mode: "send", path });
    } catch (err) {
      wait.catch(() => undefined);
      this.failWaiters(err as Error);
      throw err;
    }
    return wait;
  }

  /** Mutations run one at a time so each one's confirmation is unambiguous. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private requireReady(): void {
    if (!this.synced) throw new ApiError(503, "syncing", "The API is still loading the vault; try again in a few seconds.");
    if (!this.connected) throw new ApiError(503, "disconnected", "Not connected to the sync server; try again shortly.");
  }

  private writeVersion(): number {
    const v = this.cfg.e2eeVersion ?? this.seenVersion ?? 2;
    if (!this.e2ee!.supports(v)) {
      throw new ApiError(500, "e2ee_unavailable", `Cannot encrypt at format v${v} (no per-install salt from the server).`);
    }
    return v;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  get(path: string): Note | undefined {
    return this.notes.get(path);
  }

  /** A readable text note, or the matching API error. */
  requireText(path: string): Note & { text: string } {
    const note = this.notes.get(path);
    if (!note) throw new ApiError(404, "not_found", `No note at "${path}".`);
    if (note.kind === "binary") throw new ApiError(415, "not_text", `"${path}" is a binary attachment; the API only reads text notes.`);
    if (note.kind === "unreadable" || note.text === null) {
      throw new ApiError(409, "unreadable", note.reason ?? `"${path}" cannot be read.`);
    }
    return note as Note & { text: string };
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  write(path: string, text: string, opts: { expectedSha1?: string; createOnly?: boolean } = {}): Promise<{ note: Note; created: boolean; changed: boolean }> {
    return this.exclusive(async () => {
      this.requireReady();
      const cur = this.notes.get(path);
      if (opts.createOnly && cur) {
        throw new ApiError(409, "already_exists", `A note already exists at "${path}".`, { sha1: cur.sha1 });
      }
      this.checkExpected(path, cur, opts.expectedSha1);
      if (cur && cur.kind !== "text") this.requireText(path); // throws the right error
      return this.upload(path, text, cur);
    });
  }

  edit(path: string, ops: EditOp[], opts: { expectedSha1?: string } = {}): Promise<{ note: Note; created: boolean; changed: boolean }> {
    return this.exclusive(async () => {
      this.requireReady();
      const cur = this.requireText(path);
      this.checkExpected(path, cur, opts.expectedSha1);
      return this.upload(path, applyEdits(cur.text, ops), cur);
    });
  }

  private checkExpected(path: string, cur: Note | undefined, expected: string | undefined): void {
    if (expected === undefined) return;
    if ((cur?.sha1 ?? "") !== expected) {
      throw new ApiError(409, "stale", `"${path}" changed since you read it. Read it again and reapply your change.`, { sha1: cur?.sha1 ?? null });
    }
  }

  private async upload(path: string, text: string, cur: Note | undefined): Promise<{ note: Note; created: boolean; changed: boolean }> {
    const plain = Buffer.from(text, "utf8");
    if (plain.length > this.cfg.maxNoteBytes) {
      throw new ApiError(413, "too_large", `Note content exceeds the ${this.cfg.maxNoteBytes} byte limit.`);
    }
    const sha1 = sha1Hex(plain);
    if (cur && cur.sha1 === sha1) return { note: cur, created: false, changed: false };

    // Strictly newer than what we replace, even if this host's clock is behind.
    const mtime = Math.max(Date.now(), (cur?.mtime ?? 0) + 1);
    const bytes = this.e2ee ? this.e2ee.encrypt(plain, this.writeVersion()) : plain;
    const file: FileEntry = { path, sha1, mtime, action: "active", fileType: "file" };

    this.results.delete(path);
    this.send({ type: "file_data", mode: "apply", file, content: "", contentBytes: bytes, ...(cur?.sha1 ? { baseSha1: cur.sha1 } : {}) });
    // The server acks nothing on success, so confirm via the version history —
    // it is answered on the same ordered socket, after any conflict verdict.
    const versions = await this.history(path);
    const verdict = this.results.get(path)?.result;
    if (verdict === "conflict" || verdict === "structural_conflict") {
      throw new ApiError(409, "conflict", `"${path}" was changed on another device at the same moment. Your version was kept as a conflict record in IonSync (nothing is lost); read the note again and reapply your change.`);
    }
    if (!versions.some((v) => v.sha1 === sha1)) {
      throw new ApiError(502, "rejected", `The sync server did not accept the write to "${path}".`);
    }
    const note: Note = { path, sha1, mtime, size: plain.length, kind: "text", text };
    this.notes.set(path, note);
    this.cfg.log(`[api] wrote ${path} (${plain.length}b)`);
    return { note, created: !cur, changed: true };
  }

  delete(path: string, opts: { expectedSha1?: string } = {}): Promise<void> {
    return this.exclusive(async () => {
      this.requireReady();
      const cur = this.notes.get(path);
      if (!cur) throw new ApiError(404, "not_found", `No note at "${path}".`);
      this.checkExpected(path, cur, opts.expectedSha1);

      // A runaway caller must not be able to empty the vault: cap the rate.
      const now = Date.now();
      this.deleteTimes = this.deleteTimes.filter((t) => now - t < 3_600_000);
      if (this.deleteTimes.length >= this.cfg.maxDeletesPerHour) {
        throw new ApiError(429, "delete_limit", `Delete limit reached (${this.cfg.maxDeletesPerHour} per hour). This guards against runaway deletion; try again later.`);
      }

      const file: FileEntry = { path, sha1: cur.sha1, mtime: now, action: "deleted", fileType: "file" };
      this.send({ type: "file_data", mode: "apply", file, content: "" });
      const head = await this.fetchHead(path);
      if (head.file.action !== "deleted") {
        throw new ApiError(502, "rejected", `The sync server did not accept the delete of "${path}".`);
      }
      this.deleteTimes.push(now);
      this.notes.delete(path);
      this.cfg.log(`[api] deleted ${path}`);
    });
  }

  move(from: string, to: string): Promise<{ note: Note; conflict: boolean }> {
    return this.exclusive(async () => {
      this.requireReady();
      const cur = this.notes.get(from);
      if (!cur) throw new ApiError(404, "not_found", `No note at "${from}".`);
      if (from === to) return { note: cur, conflict: false };
      if (this.notes.has(to)) throw new ApiError(409, "already_exists", `A note already exists at "${to}".`);
      if (!this.caps.includes("file_rename")) {
        throw new ApiError(501, "unsupported", "This sync server does not support atomic renames.");
      }

      this.results.delete(from);
      this.send({ type: "file_rename", from, to, sha1: cur.sha1, mtime: cur.mtime, baseSha1: cur.sha1, fileType: "file" });
      // Re-read the target rather than trusting the mirror: if the rename raced
      // an edit on another device, the server decides what `to` now holds.
      const head = await this.fetchHead(to);
      if (head.file.action !== "active") {
        throw new ApiError(502, "rejected", `The sync server did not complete the move to "${to}".`);
      }
      const note = this.toNote(head.file, head.content ? Buffer.from(head.content, "base64") : null);
      this.notes.delete(from);
      this.notes.set(to, note);
      this.cfg.log(`[api] moved ${from} -> ${to}`);
      return { note, conflict: this.results.get(from)?.result === "structural_conflict" };
    });
  }
}
