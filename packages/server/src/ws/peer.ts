import type WebSocket from "ws";
import type { ServerMsg } from "@ionsync/protocol";

export interface SyncPeer {
  /** Unique ID assigned at connection time (UUID). */
  id: string;
  ws: WebSocket;
  /** Vault device ID — set after successful auth. */
  deviceId?: string;
  /** Whether this peer has authenticated. */
  authed: boolean;
  /** Paths actively requested from the client right now (in-flight). */
  pendingUploads: Set<string>;
  /** Paths waiting to be requested once in-flight slots free up. */
  uploadQueue: string[];
  /** Server-newer files waiting to be pushed to the client one at a time. */
  pushQueue: import("@ionsync/protocol").FileEntry[];
  /** True while a sync session is in progress (used to gate sync_done). */
  syncSessionActive: boolean;
  /**
   * When set, the next `sync_done` reports this seq as the client's new cursor
   * (cursor sync, phase 1). Undefined for legacy `sync` sessions, which send
   * `sync_done` with no cursor. Cleared once `sync_done` is sent.
   */
  cursorTarget?: number;
  /** Accumulates client FileEntry records across chunked sync messages. Cleared after last chunk. */
  syncClientMap?: Map<string, import("@ionsync/protocol").FileEntry>;
  /** Whether auto-sync (live broadcast from other peers) is enabled. */
  autoSync: boolean;
  /** Nonce sent during challenge — kept for token validation. */
  nonce: string;
  send(msg: ServerMsg): void;
  disconnect(reason?: string): void;
}

export function createPeer(id: string, nonce: string, ws: WebSocket): SyncPeer {
  const peer: SyncPeer = {
    id,
    nonce,
    ws,
    authed: false,
    pendingUploads: new Set(),
    uploadQueue: [],
    pushQueue: [],
    syncSessionActive: false,
    autoSync: true,

    send(msg) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },

    disconnect(reason) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close(1000, reason ?? "Disconnected");
      }
    },
  };
  return peer;
}
