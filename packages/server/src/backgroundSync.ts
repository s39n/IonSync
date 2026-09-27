/**
 * Background flush for mobile clients (sendBeacon).
 *
 * When Obsidian mobile is backgrounded the OS freezes its JS within moments. The
 * plugin flushes pending edits over the WebSocket first, but `ws.send()` only
 * queues bytes — iOS can suspend the app before they leave the device, and the
 * plugin has already marked the edit as synced. `navigator.sendBeacon()` is the
 * one delivery path the platform completes after the page is frozen, so the
 * plugin ALSO beacons the same uploads here.
 *
 * Safety model — this is a second write entry point, so it must not be a weaker
 * one than the WebSocket:
 *   - Auth: a random, device-bound token handed out in `auth_ok` over the
 *     already-authenticated socket. Only its SHA-256 is stored; one live token
 *     per device (a reconnect rotates it); expires after BG_TOKEN_TTL_MS; lost on
 *     restart (the plugin's confirm-on-reconnect covers that).
 *   - Every edit goes through `handleFileUpload` — the exact WS apply path, so
 *     conflict detection (baseSha1), the no-op/echo guard, the size limit, SHA1
 *     verification and E2EE handling are identical. Nothing is special-cased.
 *   - Paths are validated with the same `isValidVaultPath` the WS dispatcher
 *     uses. Only active FILE uploads are accepted: a beacon can never delete,
 *     rename, or create a folder, so it cannot cascade anything.
 *   - Bounded: body size (router), file count, and a per-device rate limit.
 *   - Duplicates are harmless: when the WS flush did drain, the beaconed copy is
 *     a byte-identical resend and is dropped by the no-op guard (no broadcast).
 */
import { randomBytes, randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { FileDataUploadMsg, FileEntry } from "@ionsync/protocol";
import type { SyncContext } from "./context.js";
import { sha256 } from "./crypto.js";
import { isValidVaultPath } from "./paths.js";
import { createPeer, type SyncPeer } from "./ws/peer.js";
import { handleFileUpload } from "./ws/handlers/fileData.js";

/** A token only needs to outlive the session it was issued in (it is rotated on
 *  every connect); 24h is a generous ceiling for a phone left in the background. */
export const BG_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Max uploads in one beacon. A beacon is ≤ ~64 KB anyway; this bounds work. */
export const BG_MAX_FILES = 50;
/** Per-device request budget. */
export const BG_RATE_LIMIT = 20;
export const BG_RATE_WINDOW_MS = 60_000;

interface TokenRecord { deviceId: string; expiresAt: number }

// Keyed by context so each server instance (and each test server) is isolated,
// without widening the SyncContext interface.
const tokenStores = new WeakMap<SyncContext, Map<string, TokenRecord>>();
const rateStores = new WeakMap<SyncContext, Map<string, number[]>>();

function tokensFor(ctx: SyncContext): Map<string, TokenRecord> {
  let m = tokenStores.get(ctx);
  if (!m) { m = new Map(); tokenStores.set(ctx, m); }
  return m;
}

function ratesFor(ctx: SyncContext): Map<string, number[]> {
  let m = rateStores.get(ctx);
  if (!m) { m = new Map(); rateStores.set(ctx, m); }
  return m;
}

/**
 * Issue a fresh background-flush token for an authenticated device. Any earlier
 * token for the same device is revoked, and expired tokens are swept.
 */
export function issueBgToken(ctx: SyncContext, deviceId: string, now = Date.now()): string {
  const store = tokensFor(ctx);
  for (const [h, rec] of store) {
    if (rec.expiresAt <= now || rec.deviceId === deviceId) store.delete(h);
  }
  const token = randomBytes(32).toString("base64url");
  store.set(sha256(token), { deviceId, expiresAt: now + BG_TOKEN_TTL_MS });
  return token;
}

/** The device a token belongs to, or null if unknown/expired. */
export function resolveBgToken(ctx: SyncContext, token: unknown, now = Date.now()): string | null {
  if (typeof token !== "string" || token.length === 0 || token.length > 128) return null;
  const store = tokensFor(ctx);
  const h = sha256(token);
  const rec = store.get(h);
  if (!rec) return null;
  if (rec.expiresAt <= now) { store.delete(h); return null; }
  return rec.deviceId;
}

function rateLimited(ctx: SyncContext, deviceId: string, now: number): boolean {
  const rates = ratesFor(ctx);
  const recent = (rates.get(deviceId) ?? []).filter((t) => now - t < BG_RATE_WINDOW_MS);
  if (recent.length >= BG_RATE_LIMIT) { rates.set(deviceId, recent); return true; }
  recent.push(now);
  rates.set(deviceId, recent);
  return false;
}

/** A peer that is never listening: `send()` is a no-op because its socket is
 *  closed. The device reconciles anything we'd have told it on its next connect.
 *  It reuses the id of the device's live peer (if its old socket is still
 *  registered) so broadcastToPeers never echoes the edit back to its author. */
function syntheticPeer(ctx: SyncContext, deviceId: string): SyncPeer {
  let id = `bg-${randomUUID()}`;
  for (const p of ctx.peers.values()) {
    if (p.deviceId === deviceId) { id = p.id; break; }
  }
  const closedSocket = {
    readyState: 3, OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3,
    send() { /* not listening */ },
    close() { /* already closed */ },
  } as unknown as WebSocket;
  const peer = createPeer(id, "", closedSocket);
  peer.authed = true;
  peer.deviceId = deviceId;
  return peer;
}

const SHA1_RE = /^[0-9a-f]{40}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

interface ParsedUpload { file: FileEntry; content: string; baseSha1?: string }

/** Validate one beaconed upload; null if it is anything but a sane active-file write. */
function parseUpload(raw: unknown): ParsedUpload | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { file?: unknown; content?: unknown; baseSha1?: unknown };
  const f = r.file as Partial<FileEntry> | undefined;
  if (!f || typeof f !== "object") return null;
  if (!isValidVaultPath(f.path)) return null;
  if (f.action !== "active" || f.fileType !== "file") return null; // never a delete/folder
  if (typeof f.sha1 !== "string" || !SHA1_RE.test(f.sha1)) return null;
  if (typeof f.mtime !== "number" || !Number.isFinite(f.mtime) || f.mtime <= 0) return null;
  if (typeof r.content !== "string" || !BASE64_RE.test(r.content)) return null;
  if (r.baseSha1 !== undefined && (typeof r.baseSha1 !== "string" || !SHA1_RE.test(r.baseSha1))) return null;
  const file: FileEntry = {
    path: f.path, sha1: f.sha1, mtime: f.mtime, action: "active", fileType: "file",
    ...(typeof f.size === "number" && Number.isFinite(f.size) && f.size >= 0 ? { size: f.size } : {}),
  };
  return { file, content: r.content, ...(typeof r.baseSha1 === "string" ? { baseSha1: r.baseSha1 } : {}) };
}

export interface BgSyncResult { status: 204 | 400 | 401 | 429; applied: number }

/**
 * Apply a beaconed batch. `rawBody` is the request body as text (beacons are sent
 * as text/plain to stay a CORS "simple request").
 */
export function handleBackgroundSync(ctx: SyncContext, rawBody: unknown, now = Date.now()): BgSyncResult {
  let body: unknown;
  try { body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody; }
  catch { return { status: 400, applied: 0 }; }
  if (!body || typeof body !== "object") return { status: 400, applied: 0 };
  const { token, files } = body as { token?: unknown; files?: unknown };

  const deviceId = resolveBgToken(ctx, token, now);
  if (!deviceId) return { status: 401, applied: 0 };
  if (rateLimited(ctx, deviceId, now)) return { status: 429, applied: 0 };
  if (!Array.isArray(files) || files.length === 0 || files.length > BG_MAX_FILES) {
    return { status: 400, applied: 0 };
  }

  const uploads: ParsedUpload[] = [];
  for (const raw of files) {
    const u = parseUpload(raw);
    if (!u) {
      log(ctx, `[bg-sync] rejected a malformed upload from ${deviceId}`);
      return { status: 400, applied: 0 }; // all-or-nothing: a bad entry means a bad client
    }
    uploads.push(u);
  }

  ctx.db.touchDevice(deviceId);
  const peer = syntheticPeer(ctx, deviceId);
  for (const u of uploads) {
    const msg: FileDataUploadMsg = {
      type: "file_data",
      mode: "apply",
      file: u.file,
      content: u.content,
      ...(u.baseSha1 ? { baseSha1: u.baseSha1 } : {}),
    };
    handleFileUpload(ctx, peer, msg);
  }
  log(ctx, `[bg-sync] ${deviceId}: applied ${uploads.length} background upload(s)`);
  return { status: 204, applied: uploads.length };
}

function log(ctx: SyncContext, msg: string): void {
  if (ctx.config.logs.level < 3) return;
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  ctx.logBuffer.push(line);
  if (ctx.logBuffer.length > 200) ctx.logBuffer.shift();
}
