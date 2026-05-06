import type { FileDataUploadMsg, FileDataRequestMsg } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import type { SyncPeer } from "../peer.js";
import { broadcastToPeers } from "./sync.js";
import { sha1 } from "../../crypto.js";

/**
 * Client is uploading a file to the server (mode: "apply").
 */
export function handleFileUpload(
  ctx: SyncContext,
  peer: SyncPeer,
  msg: FileDataUploadMsg
): void {
  const { file, content } = msg;

  // Persist content for active files (not folders, not deleted)
  if (file.action === "active" && file.fileType === "file" && content) {
    const buf = Buffer.from(content, "base64");

    // Verify SHA1 — reject corrupted uploads silently (client will retry on next sync)
    if (file.sha1) {
      const computed = sha1(buf);
      if (computed !== file.sha1) {
        logWarn(ctx, `[file_data] SHA1 mismatch for ${file.path} — rejecting upload`);
        return;
      }
    }

    ctx.storage.write(file.path, file.mtime, buf);
  }

  // Update the DB record
  ctx.db.upsertFile(file);

  // Mark pending upload as resolved — only counts if it was part of a sync session
  const wasPending = peer.pendingUploads.has(file.path);
  peer.pendingUploads.delete(file.path);

  // Drain one from the queue now that a slot has opened up
  if (peer.uploadQueue.length > 0) {
    const next = peer.uploadQueue.shift()!;
    peer.pendingUploads.add(next);
    peer.send({ type: "file_event_result", path: next, result: "client_newer" });
  }

  // Send sync_done only when in-flight and queued uploads are both exhausted
  if (wasPending && peer.pendingUploads.size === 0 && peer.uploadQueue.length === 0) {
    peer.send({ type: "sync_done" });
  }

  // Broadcast to other connected peers (live sync)
  broadcastToPeers(ctx, peer, file);

  logInfo(ctx, `[file_data] saved ${file.path} (action=${file.action}, mtime=${file.mtime})`);
}

/**
 * Client is requesting a file from the server (mode: "send").
 * Used by the plugin for version restore (download a specific file).
 */
export function handleFileDownload(
  ctx: SyncContext,
  peer: SyncPeer,
  msg: FileDataRequestMsg
): void {
  const file = ctx.db.getFile(msg.path);

  if (!file) {
    logWarn(ctx, `[file_data] download requested for unknown path: ${msg.path}`);
    return;
  }

  let content = "";
  if (file.action === "active" && file.fileType === "file") {
    const buf = ctx.storage.readLatest(file.path);
    content = buf ? buf.toString("base64") : "";
  }

  peer.send({ type: "file_data_response", file, content });
}

function logInfo(ctx: SyncContext, msg: string): void {
  if (ctx.config.logs.level >= 3) pushLog(ctx, msg);
}

function logWarn(ctx: SyncContext, msg: string): void {
  if (ctx.config.logs.level >= 2) pushLog(ctx, `[WARN] ${msg}`);
}

function pushLog(ctx: SyncContext, msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  ctx.logBuffer.push(line);
  if (ctx.logBuffer.length > 200) ctx.logBuffer.shift();
}
