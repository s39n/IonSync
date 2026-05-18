import type { FileDataUploadMsg, FileDataRequestMsg } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import { pushActivity } from "../../context.js";
import type { SyncPeer } from "../peer.js";
import { broadcastToPeers, checkSyncDone } from "./sync.js";
import crypto from "node:crypto";

// Magic header written by the plugin's Crypto.ts when E2EE is enabled.
// Matches the first 8 bytes of the binary payload (MAGIC = "IONENCv1").
const E2EE_MAGIC = Buffer.from([0x49, 0x4f, 0x4e, 0x45, 0x4e, 0x43, 0x76, 0x31]);

/**
 * Client is uploading a file to the server (mode: "apply").
 */
export function handleFileUpload(
  ctx: SyncContext,
  peer: SyncPeer,
  msg: FileDataUploadMsg
): void {
  const { file, content } = msg;
  let isRejected = false;
  let isE2EE = false;

  // Persist content for active files (not folders, not deleted)
  if (file.action === "active" && file.fileType === "file" && content) {
    const buf = Buffer.from(content, "base64");

    // Detect E2EE: the plugin prepends an 8-byte magic header ("IONENCv1")
    // to every encrypted payload.  When present the SHA1 in the file entry
    // is of the *plaintext* (not the ciphertext), so we must skip the SHA1
    // check -- the server can't verify content it cannot decrypt.
    isE2EE = buf.length >= E2EE_MAGIC.length && buf.slice(0, E2EE_MAGIC.length).equals(E2EE_MAGIC);

    // 1. Check size limit
    const limitBytes = ctx.config.maxFileSizeMb * 1024 * 1024;
    if (buf.length > limitBytes) {
      logWarn(ctx, `[Upload] Rejected ${file.path}. Size exceeds limit.`);
      isRejected = true;
    }
    // 2. Verify SHA1 -- skipped for E2EE uploads (SHA1 is of plaintext; we store ciphertext)
    else if (!isE2EE && file.sha1) {
      const computed = crypto.createHash("sha1").update(buf).digest("hex");
      if (computed !== file.sha1) {
        logWarn(ctx, `[file_data] SHA1 mismatch for ${file.path} -- rejecting upload.`);
        isRejected = true;
      }
    }

    // 3. Save healthy files
    if (!isRejected) {
      ctx.storage.write(file.path, file.mtime, buf);
    }

    // Help the GC clear the buffer promptly
    msg.content = "";
  }

  // Only update the database and broadcast if the file was ACTUALLY saved
  if (!isRejected) {
    ctx.db.upsertFile(file);
    broadcastToPeers(ctx, peer, file);
    logInfo(ctx, `[file_data] saved ${file.path} (action=${file.action}, mtime=${file.mtime})`);
    pushActivity(ctx, { kind: "upload", deviceId: peer.deviceId ?? undefined, path: file.path });

    // If this upload is encrypted, purge any older unencrypted versions for this
    // path. Once an encrypted copy exists the server should never push stale
    // plaintext to E2EE-enabled clients -- those versions are now worthless and
    // only cause "Unencrypted file received" alerts on restore.
    if (isE2EE) {
      purgeUnencryptedVersions(ctx, file.path, file.mtime);
    }
  }

  // CRITICAL: Always advance the queue, even if the file was rejected!
  peer.pendingUploads.delete(file.path);

  if (peer.uploadQueue.length > 0) {
    const next = peer.uploadQueue.shift()!;
    peer.pendingUploads.add(next);
    peer.send({ type: "file_event_result", path: next, result: "client_newer" });
  }

  // Check whether sync is fully complete
  checkSyncDone(peer);
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
    const buf = msg.mtime !== undefined
      ? ctx.storage.readVersion(file.path, msg.mtime)
      : ctx.storage.readLatest(file.path);
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

/**
 * After an encrypted upload is saved, delete any older stored versions for the
 * same path that are NOT encrypted (lack the E2EE magic header). Those
 * pre-E2EE versions are now unreachable without the key and would only cause
 * "Unencrypted file received" alerts if ever pushed to an E2EE-enabled client.
 */
function purgeUnencryptedVersions(ctx: SyncContext, filePath: string, currentMtime: number): void {
  const allMtimes = ctx.storage.listVersionMtimes(filePath);
  let purgeCount = 0;
  for (const mtime of allMtimes) {
    if (mtime >= currentMtime) continue; // keep current version and anything newer
    const buf = ctx.storage.readVersion(filePath, mtime);
    if (!buf) continue;
    const isEncrypted = buf.length >= E2EE_MAGIC.length && buf.slice(0, E2EE_MAGIC.length).equals(E2EE_MAGIC);
    if (!isEncrypted) {
      ctx.storage.deleteVersion(filePath, mtime);
      ctx.db.deleteVersionRecord(filePath, mtime);
      purgeCount++;
    }
  }
  if (purgeCount > 0) {
    logInfo(ctx, `[Upload] Purged ${purgeCount} unencrypted version(s) for ${filePath}`);
  }
}
