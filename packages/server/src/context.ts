import type { Config } from "./config.js";
import type { SyncDB } from "./db/index.js";
import type { Storage } from "./storage/index.js";
import type { SyncPeer } from "./ws/peer.js";

export interface SyncContext {
  config: Config;
  db: SyncDB;
  storage: Storage;
  /** Connected, authenticated peers. Keyed by peer ID (UUID assigned at connect). */
  peers: Map<string, SyncPeer>;
  /** Rolling in-memory log buffer — last 200 lines. */
  logBuffer: string[];
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
    clientDir,
  };
}
