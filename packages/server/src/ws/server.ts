import { WebSocketServer, type WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import type { ClientMsg } from "@ionsync/protocol";
import type { SyncContext } from "../context.js";
import { createPeer } from "./peer.js";
import { handleAuth } from "./handlers/auth.js";
import { handleSync } from "./handlers/sync.js";
import { handleFileEvent } from "./handlers/fileEvent.js";
import { handleFileUpload, handleFileDownload } from "./handlers/fileData.js";
import { handleFileHistory } from "./handlers/fileHistory.js";
import { handleVersionCheck } from "./handlers/versionCheck.js";
import type { IncomingMessage } from "node:http";

export function attachWebSocketServer(
  ctx: SyncContext,
  httpServer: import("node:http").Server | import("node:https").Server
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    const peerId = uuidv4();
    const nonce = uuidv4();
    const peer = createPeer(peerId, nonce, ws);

    ctx.peers.set(peerId, peer);

    // Send challenge immediately
    peer.send({ type: "challenge", nonce });

    // Disconnect timeout if not authed within 5 seconds
    const authTimeout = setTimeout(() => {
      if (!peer.authed) {
        peer.disconnect("Auth timeout");
      }
    }, 5_000);

    ws.on("message", (raw: Buffer) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString()) as ClientMsg;
      } catch {
        // Ignore malformed messages
        return;
      }

      // Auth must come first
      if (!peer.authed) {
        if (msg.type === "auth") {
          clearTimeout(authTimeout);
          handleAuth(ctx, peer, msg);
        } else {
          peer.disconnect("Not authenticated");
        }
        return;
      }

      // Update last_online on every message
      if (peer.deviceId) {
        ctx.db.touchDevice(peer.deviceId);
      }

      switch (msg.type) {
        case "version_check":
          handleVersionCheck(ctx, peer, msg);
          break;
        case "sync":
          handleSync(ctx, peer, msg);
          break;
        case "file_event":
          handleFileEvent(ctx, peer, msg);
          break;
        case "file_data":
          if (msg.mode === "apply") {
            handleFileUpload(ctx, peer, msg);
          } else {
            handleFileDownload(ctx, peer, msg);
          }
          break;
        case "file_history":
          handleFileHistory(ctx, peer, msg);
          break;
        // "auth" after already authed → ignore
        default:
          break;
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      ctx.peers.delete(peerId);
    });

    ws.on("error", (err: Error) => {
      pushLog(ctx, `[ws] peer ${peerId} error: ${err.message}`);
      ctx.peers.delete(peerId);
    });
  });

  return wss;
}

function pushLog(ctx: SyncContext, msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.error(line);
  ctx.logBuffer.push(line);
  if (ctx.logBuffer.length > 200) ctx.logBuffer.shift();
}
