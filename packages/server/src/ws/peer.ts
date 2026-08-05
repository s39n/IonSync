import type WebSocket from "ws";
import type { ServerMsg } from "@ionsync/protocol";
import { encodeFrame, BINARY_FRAMES_CAP } from "@ionsync/protocol";

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
  /**
   * True when the current cursor batch was full and more changes remain — the
   * next `sync_done` carries `more:true` so the client pulls another batch.
   */
  syncMore: boolean;
  /** Accumulates client FileEntry records across chunked sync messages. Cleared after last chunk. */
  syncClientMap?: Map<string, import("@ionsync/protocol").FileEntry>;
  /** Whether auto-sync (live broadcast from other peers) is enabled. */
  autoSync: boolean;
  /**
   * Live sync-progress telemetry for the dashboard (cursor bootstrap view).
   * `syncActive` is true while a cursor session is streaming; `syncCursor` is
   * the highest seq delivered so far; `syncTargetSeq` is the server counter the
   * session is catching up to; `syncPushed` counts files streamed this session.
   * Percent = syncCursor / syncTargetSeq. Purely observational — never gates sync.
   */
  syncActive: boolean;
  syncCursor: number;
  syncTargetSeq: number;
  syncPushed: number;
  /** Nonce sent during challenge — kept for token validation. */
  nonce: string;
  /** Capability tokens the client advertised in version_check (e.g.
   *  "binary_frames"). Empty until version_check; gates binary framing for this
   *  peer so an old client keeps getting base64-in-JSON. */
  caps: string[];
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
    syncMore: false,
    autoSync: true,
    syncActive: false,
    syncCursor: 0,
    syncTargetSeq: 0,
    syncPushed: 0,
    caps: [],

    send(msg) {
      if (ws.readyState === ws.OPEN) {
        // encodeFrame emits a binary frame for content-bearing messages when
        // this peer negotiated "binary_frames"; otherwise a JSON string
        // (base64ing any raw bytes back into `content`). ws sends a
        // Uint8Array as a binary frame and a string as a text frame.
        ws.send(encodeFrame(msg, this.caps.includes(BINARY_FRAMES_CAP)));
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
