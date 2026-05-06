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
  /** Paths the server is waiting for the client to upload (client_newer). */
  pendingUploads: Set<string>;
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
