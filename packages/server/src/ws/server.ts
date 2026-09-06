import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import type { ClientMsg } from "@ionsync/protocol";
import { decodeFrame } from "@ionsync/protocol";
import type { SyncContext } from "../context.js";
import { pushActivity } from "../context.js";
import { createPeer } from "./peer.js";
import { handleAuth } from "./handlers/auth.js";
import { handleSync } from "./handlers/sync.js";
import { handleSyncCursor } from "./handlers/syncCursor.js";
import { handleFileEvent } from "./handlers/fileEvent.js";
import { handleFileUpload, handleFileDownload, handleConflictUpload } from "./handlers/fileData.js";
import { handleFileHistory } from "./handlers/fileHistory.js";
import {
  handleConflictList,
  handleConflictContent,
  handleConflictResolve,
  handleConflictRestore,
} from "./handlers/conflicts.js";
import { handleRename } from "./handlers/rename.js";
import { handleVersionCheck } from "./handlers/versionCheck.js";
import { handleVerifyRequest, handleVerifyMissing } from "./handlers/verify.js";
import { ConnectionRateLimiter } from "./rateLimit.js";
import type { IncomingMessage } from "node:http";
import { diff_match_patch } from "diff-match-patch"; // ✅ Phase 2 Import

export function attachWebSocketServer(
  ctx: SyncContext,
  httpServer: import("node:http").Server | import("node:https").Server
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 50 * 1024 * 1024 });

  const isAlive = new WeakMap<WebSocket, boolean>();
  const rateLimiter = new ConnectionRateLimiter();

  const pingInterval = setInterval(() => {
    rateLimiter.sweep();
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

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const ip = req.socket.remoteAddress ?? "unknown";

    // Per-IP connection cap: refuse (and immediately close) connections from an
    // IP that is flooding or has been blocked for repeated auth failures. We
    // close rather than leave the socket open so a flooding client cannot hold
    // file descriptors / memory.
    if (!rateLimiter.allowConnection(ip)) {
      pushLog(ctx, `[ratelimit] refused connection from ${ip}`);
      ws.close(1013, "Rate limited"); // 1013 = Try Again Later
      return;
    }

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
    ws.on("message", async (raw: Buffer, isBinary: boolean) => {
      let msg: ClientMsg;
      try {
        // Binary frame → decode the [len][header][bytes] envelope (content
        // arrives as msg.contentBytes). Text frame → JSON as before. ws hands
        // us a Buffer either way, so the isBinary flag is what disambiguates.
        msg = decodeFrame(isBinary ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : raw.toString()) as ClientMsg;
      } catch {
        return;
      }

      if (!peer.authed) {
        if (msg.type === "auth") {
          clearTimeout(authTimeout);
          handleAuth(ctx, peer, msg);
          if (peer.authed) {
            pushActivity(ctx, { kind: "connect", deviceId: peer.deviceId ?? undefined, detail: peer.id });
          } else {
            // Wrong password: count it toward the per-IP brute-force budget so a
            // guessing client gets blocked well before exhausting the keyspace.
            rateLimiter.recordAuthFailure(ip);
          }
        } else {
          peer.disconnect("Not authenticated");
        }
        return;
      }

      if (peer.deviceId) {
        ctx.db.touchDevice(peer.deviceId);
      }

      // A throwing handler must never escape this callback: the listener is
      // async, so an uncaught exception becomes an unhandled promise rejection
      // (fatal in modern Node) and, less dramatically, can strand a sync
      // session with pendingUploads never advancing.
      try {
      switch (msg.type) {
        case "version_check":
          handleVersionCheck(ctx, peer, msg);
          break;
        case "sync":
          handleSync(ctx, peer, msg);
          break;
        case "sync_cursor":
          handleSyncCursor(ctx, peer, msg);
          break;
        case "file_event":
          handleFileEvent(ctx, peer, msg);
          break;
        case "file_data": {
          // `msg` is already narrowed to the file_data client messages by the
          // switch; `.mode` discriminates upload / patch / conflict / download.
          const rawMsg = msg;

          if (rawMsg.mode === "patch") {
            // Conflict pre-check: a delta patch is only meaningful against the
            // base it was diffed from. If the server head has moved past the
            // client's baseSha1, stitching would corrupt the file — ask for the
            // full file instead. The client's shadow already matches its current
            // text, so the retry arrives as mode:"apply" and goes through the
            // regular conflict gate in handleFileUpload.
            const headFile = ctx.db.getFile(rawMsg.file.path);
            if (
              rawMsg.baseSha1 !== undefined &&
              headFile &&
              headFile.action === "active" &&
              rawMsg.baseSha1 !== headFile.sha1
            ) {
              pushLog(ctx, `[Delta] Stale base for ${rawMsg.file.path} — requesting full upload`);
              peer.pendingUploads.add(rawMsg.file.path);
              peer.send({ type: "file_event_result", path: rawMsg.file.path, result: "client_newer" });
              break;
            }
            try {
              console.log(`[Delta Patch] Stitching update for: ${rawMsg.file.path}`);

              // 1. Read current server file (latest stored version)
              const currentBuffer = ctx.storage.readLatest(rawMsg.file.path);
              const currentText = currentBuffer ? currentBuffer.toString("utf-8") : "";

              // 2. Apply the incoming patch
              const dmp = new diff_match_patch();
              const patches = dmp.patch_fromText(rawMsg.content);
              const [newText, results] = dmp.patch_apply(patches, currentText);

              // patch_apply reports per-hunk success; a partial apply produces
              // text that won't match the client's SHA1 and would either be
              // silently rejected (delaying sync a full cycle) or, for E2EE-ish
              // edge cases, stored corrupted. Request the full file instead.
              if ((results).some((ok) => !ok)) {
                pushLog(ctx, `[Delta] Partial patch apply for ${rawMsg.file.path} — requesting full upload`);
                peer.pendingUploads.add(rawMsg.file.path);
                peer.send({ type: "file_event_result", path: rawMsg.file.path, result: "client_newer" });
                break;
              }

              // 3. Morph into a standard 'apply' full-file upload and hand off.
              //    Build a derived message rather than mutating rawMsg, so the
              //    discriminated-union narrowing in the branches below stays intact.
              handleFileUpload(ctx, peer, {
                ...rawMsg,
                mode: "apply",
                content: Buffer.from(newText, "utf-8").toString("base64"),
              });
            } catch (err) {
              pushLog(ctx, `[Delta] Failed to patch ${rawMsg.file?.path}: ${err}`);
              // Recover by pulling the full file rather than leaving the path stuck.
              peer.pendingUploads.add(rawMsg.file.path);
              peer.send({ type: "file_event_result", path: rawMsg.file.path, result: "client_newer" });
            }
          }
          else if (rawMsg.mode === "apply") {
            handleFileUpload(ctx, peer, rawMsg);
          }
          else if (rawMsg.mode === "conflict") {
            handleConflictUpload(ctx, peer, rawMsg);
          }
          else if (rawMsg.mode === "send") {
            handleFileDownload(ctx, peer, rawMsg);
          }
          break;
        }
        case "file_history":
          handleFileHistory(ctx, peer, msg);
          break;
        case "conflict_list":
          handleConflictList(ctx, peer, msg);
          break;
        case "conflict_content":
          handleConflictContent(ctx, peer, msg);
          break;
        case "conflict_resolve":
          handleConflictResolve(ctx, peer, msg);
          break;
        case "conflict_restore":
          handleConflictRestore(ctx, peer, msg);
          break;
        case "file_rename":
          handleRename(ctx, peer, msg);
          break;
        case "verify_request":
          handleVerifyRequest(ctx, peer);
          break;
        case "verify_missing":
          handleVerifyMissing(ctx, peer, msg);
          break;
        default:
          break;
      }
      } catch (err) {
        pushLog(ctx, `[ws] handler error for ${msg.type} from ${peer.deviceId ?? peer.id}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
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
