import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import type { ClientMsg } from "@ionsync/protocol";
import type { SyncContext } from "../context.js";
import { pushActivity } from "../context.js";
import { createPeer } from "./peer.js";
import { handleAuth } from "./handlers/auth.js";
import { handleSync } from "./handlers/sync.js";
import { handleFileEvent } from "./handlers/fileEvent.js";
import { handleFileUpload, handleFileDownload } from "./handlers/fileData.js";
import { handleFileHistory } from "./handlers/fileHistory.js";
import { handleVersionCheck } from "./handlers/versionCheck.js";
import type { IncomingMessage } from "node:http";
import { diff_match_patch } from "diff-match-patch"; // ✅ Phase 2 Import

export function attachWebSocketServer(
  ctx: SyncContext,
  httpServer: import("node:http").Server | import("node:https").Server
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 50 * 1024 * 1024 });

  const isAlive = new WeakMap<WebSocket, boolean>();

  const pingInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (isAlive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      isAlive.set(ws, false);
      ws.ping();
    }
  }, 30_000);
  wss.on("close", () => clearInterval(pingInterval));

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    const peerId = uuidv4();
    const nonce = uuidv4();
    const peer = createPeer(peerId, nonce, ws);

    ctx.peers.set(peerId, peer);

    isAlive.set(ws, true);
    ws.on("pong", () => { isAlive.set(ws, true); });

    peer.send({ type: "challenge", nonce });

    const authTimeout = setTimeout(() => {
      if (!peer.authed) {
        peer.disconnect("Auth timeout");
      }
    }, 5_000);

    // ✅ Changed to async to support reading the current file for Delta Patching
    ws.on("message", async (raw: Buffer) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString()) as ClientMsg;
      } catch {
        return;
      }

      if (!peer.authed) {
        if (msg.type === "auth") {
          clearTimeout(authTimeout);
          handleAuth(ctx, peer, msg);
          if (peer.authed) {
            pushActivity(ctx, { kind: "connect", deviceId: peer.deviceId ?? undefined, detail: peer.id });
          }
        } else {
          peer.disconnect("Not authenticated");
        }
        return;
      }

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
        case "file_data": {
          // ✅ This is the line that was missing! It defines rawMsg so the rest of the block can use it.
          const rawMsg = msg as any; 
          
          if (rawMsg.mode === "patch") {
            try {
              console.log(`[Delta Patch] Stitching update for: ${rawMsg.file.path}`);
              
              // 1. Read current server file
              const currentBuffer = await (ctx.storage as any).read(rawMsg.file.path);
              const currentText = currentBuffer ? currentBuffer.toString("utf-8") : "";

              // 2. Apply the incoming patch
              const dmp = new diff_match_patch();
              const patches = dmp.patch_fromText(rawMsg.content);
              const [newText] = dmp.patch_apply(patches, currentText);

              // 3. Morph message into a standard 'apply' full-file upload
              rawMsg.mode = "apply";
              rawMsg.content = Buffer.from(newText, "utf-8").toString("base64");

              // 4. Hand off to your existing modular handler
              handleFileUpload(ctx, peer, rawMsg);
            } catch (err) {
              pushLog(ctx, `[Delta] Failed to patch ${rawMsg.file?.path}: ${err}`);
            }
          } 
          else if (rawMsg.mode === "apply") {
            handleFileUpload(ctx, peer, rawMsg);
          } 
          else {
            handleFileDownload(ctx, peer, rawMsg);
          }
          break;
        }
        case "file_history":
          handleFileHistory(ctx, peer, msg);
          break;
        default:
          break;
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      if (peer.authed) {
        pushActivity(ctx, { kind: "disconnect", deviceId: peer.deviceId ?? undefined, detail: peer.id });
      }
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