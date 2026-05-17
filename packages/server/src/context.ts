import type { Config } from "./config.js";
import type { SyncDB } from "./db/index.js";
import type { Storage } from "./storage/index.js";
import type { SyncPeer } from "./ws/peer.js";

export interface ActivityEvent {
  ts: number;
  kind: "upload" | "push" | "delete" | "connect" | "disconnect" | "rename";
  deviceId?: string | undefined;
  path?: string | undefined;
  detail?: string | undefined;
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
  };
}

/** Push a structured activity event (max 100 kept). */
export function pushActivity(ctx: SyncContext, event: Omit<ActivityEvent, "ts">): void {
  ctx.activityLog.push({ ts: Date.now(), ...event });
  if (ctx.activityLog.length > 100) ctx.activityLog.shift();
}
