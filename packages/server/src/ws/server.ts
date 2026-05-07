import { WebSocketServer, WebSocket } from "ws";
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
  // maxPayload caps the size of a single WebSocket message the server will accept.
  // A file_data upload embeds base64 content inside JSON, so a 25 MB file arrives
  // as ~33 MB of JSON.  The 50 MB ceiling here comfortably covers the default
  // plugin limit (25 MB → ~33 MB on the wire) with headroom to spare.
  // Connections that exceed this are closed before the message handler ever runs,
  // preventing a single giant upload from exhausting heap.
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 50 * 1024 * 1024 });

  // Track whether each connection responded to the most recent ping.
  // WeakMap avoids hacking extra properties onto WebSocket and lets GC collect
  // entries automatically when a socket is garbage-collected.
  const isAlive = new WeakMap<WebSocket, boolean>();

  // Heartbeat interval serves two purposes:
  //  1. Keeps reverse-proxy idle timeouts from killing long uploads.
  //  2. Detects "zombie" connections where TCP silently died (phone went to
  //     airplane mode, NAT table expired, etc.). A zombie never fires "close",
  //     so without this ctx.peers would grow forever and we'd keep broadcasting
  //     to sockets that are no longer reachable.
  const pingInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (isAlive.get(ws) === false) {
        // No pong since the last ping → zombie. ws.terminate() forces an
        // OS-level close, which fires the "close" event and triggers the normal
        // peer-cleanup path (ctx.peers.delete, authTimeout clear, etc.).
        ws.terminate();
        continue;
      }
      // Assume dead until the client proves otherwise with a pong frame.
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

    // Register the socket with the heartbeat tracker and reset the alive flag
    // whenever the client sends a pong frame back.  The browser WebSocket API
    // and Obsidian's mobile engine both reply to ping frames automatically — no
    // plugin-side code is needed for this.
    isAlive.set(ws, true);
    ws.on("pong", () => { isAlive.set(ws, true); });

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
