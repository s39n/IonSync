import type { ServerResponse } from "node:http";
import type { Config } from "./config.js";
import type { SyncDB } from "./db/index.js";
import type { Storage } from "./storage/index.js";
import type { SyncPeer } from "./ws/peer.js";

export interface ActivityEvent {
  ts: number;
  kind: "upload" | "push" | "delete" | "connect" | "disconnect" | "rename" | "conflict";
  deviceId?: string | undefined;
  path?: string | undefined;
  detail?: string | undefined;
}

/**
 * Live dashboard push channel (Server-Sent Events). Each connected dashboard
 * registers its response stream in `clients`; state changes call `emitSse`,
 * which coalesces bursts and writes a single `change` frame to every client.
 */
export interface SseHub {
  clients: Set<ServerResponse>;
  pendingKinds: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface SyncContext {
  config: Config;
  db: SyncDB;
  storage: Storage;
  /** Connected, authenticated peers. Keyed by peer ID (UUID assigned at connect). */
  peers: Map<string, SyncPeer>;
  /** Rolling in-memory log buffer — last 200 lines. */
  logBuffer: string[];
  /** Rolling structured activity feed — last 100 events. */
  activityLog: ActivityEvent[];
  /** Absolute path to the client/ dir containing plugin build artifacts. */
  clientDir: string;
  /** Live dashboard event stream. */
  sse: SseHub;
}

export function createContext(
  config: Config,
  db: SyncDB,
  storage: Storage,
  clientDir: string
): SyncContext {
  return {
    config,
    db,
    storage,
    peers: new Map(),
    logBuffer: [],
    activityLog: [],
    clientDir,
    sse: { clients: new Set(), pendingKinds: new Set(), timer: null },
  };
}

/** Push a structured activity event (max 100 kept). */
export function pushActivity(ctx: SyncContext, event: Omit<ActivityEvent, "ts">): void {
  ctx.activityLog.push({ ts: Date.now(), ...event });
  if (ctx.activityLog.length > 100) ctx.activityLog.shift();
  // Nudge every connected dashboard to refresh — near-instant, replacing the
  // old fixed poll. The activity feed already funnels every meaningful change
  // (uploads, renames, deletes, connect/disconnect) through here.
  emitSse(ctx, event.kind);
}

/**
 * Signal connected dashboards that server state changed. Bursts are coalesced:
 * many rapid changes (e.g. a bulk sync) collapse into one flush ~400ms later,
 * so a busy server never fires thousands of stream writes. No-op when nobody is
 * listening, so it costs nothing on a server with no open dashboard.
 */
export function emitSse(ctx: SyncContext, kind: string): void {
  ctx.sse.pendingKinds.add(kind);
  if (ctx.sse.timer) return;
  const t = setTimeout(() => flushSse(ctx), 400);
  // A pending flush must never keep the process (or a test run) alive.
  (t as { unref?: () => void }).unref?.();
  ctx.sse.timer = t;
}

function flushSse(ctx: SyncContext): void {
  ctx.sse.timer = null;
  const kinds = [...ctx.sse.pendingKinds];
  ctx.sse.pendingKinds.clear();
  if (ctx.sse.clients.size === 0) return;
  const payload = `event: change\ndata: ${JSON.stringify({ kinds, ts: Date.now() })}\n\n`;
  for (const res of ctx.sse.clients) {
    try { res.write(payload); }
    catch { ctx.sse.clients.delete(res); }
  }
}
