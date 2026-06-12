import type { FileDataUploadMsg, FileDataRequestMsg, FileEntry } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import { pushActivity } from "../../context.js";
import type { SyncPeer } from "../peer.js";
import { broadcastToPeers, checkSyncDone } from "./sync.js";
import crypto from "node:crypto";

// Magic header written by the plugin's Crypto.ts when E2EE is enabled.
// Matches the first 8 bytes of the binary payload (MAGIC = "IONENCv1").
const E2EE_MAGIC = Buffer.from([0x49, 0x4f, 0x4e, 0x45, 0x4e, 0x43, 0x76, 0x31]);

/**
 * Decide whether an upload fast-forwards the server head or is a concurrent
 * edit (conflict). Clock-independent where possible:
 *
 *   - no server record / server record deleted   → accept (new file or re-add)
 *   - upload sha == server head sha              → accept (idempotent resend)
 *   - no baseSha1 (legacy client / first sync)   → accept (LWW fallback)
 *   - baseSha1 == server head sha                → accept (fast-forward)
 *   - baseSha1 is an older *known* version       → conflict (head moved on)
 *   - baseSha1 unknown (lost-upload retry, copied vault)
 *                                                → LWW by mtime: newer accepts,
 *                                                  older/equal conflicts
 */
function decideUpload(ctx: SyncContext, msg: FileDataUploadMsg): "accept" | "conflict" | "reject_stale" {
  const { file, baseSha1 } = msg;
  if (file.action !== "active" || file.fileType !== "file") return "accept";

  const serverFile = ctx.db.getFile(file.path);
  if (!serverFile || serverFile.action === "deleted") return "accept";
  if (file.sha1 && file.sha1 === serverFile.sha1) return "accept";
  if (baseSha1 === undefined || baseSha1 === "") return "accept";
  if (baseSha1 === serverFile.sha1) return "accept";

  // Hidden/config paths (.obsidian/**, any dot-segment) flap constantly across
  // devices and have no merge value — conflict copies of them are junk that
  // multiplies on every flap. Resolve strictly by LWW: newer-or-equal wins,
  // older is rejected and re-converged via a head push. Never mint a copy.
  if (isHiddenOrConfigPath(file.path)) {
    return file.mtime >= serverFile.mtime ? "accept" : "reject_stale";
  }

  if (ctx.db.hasVersionSha(file.path, baseSha1)) return "conflict";
  // Unknown base: equal mtime is the E2EE re-encrypt / lost-ack resend pattern,
  // not a concurrent edit — accept. Only a strictly older unknown base conflicts.
  return file.mtime >= serverFile.mtime ? "accept" : "conflict";
}

/** True for paths with a dot-segment: ".obsidian/app.json", "foo/.hidden/x". */
function isHiddenOrConfigPath(p: string): boolean {
  return p.startsWith(".") || p.includes("/.");
}

/** Builds "notes/foo (Conflicted Copy 2026-06-11T19-30 abc12345).md" — same
 *  shape the plugin uses locally, plus a short device id so the origin is clear. */
function conflictCopyPath(originalPath: string, deviceId: string | undefined): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  // Only treat a dot inside the basename as an extension separator — a dot in
  // a folder name ("assets.v2/photo") must not be split, and a leading dot
  // (".gitignore") is part of the name, not an extension.
  const lastSlash = originalPath.lastIndexOf("/");
  const lastDot = originalPath.lastIndexOf(".");
  const hasExt = lastDot > lastSlash + 1;
  const pathNoExt = hasExt ? originalPath.slice(0, lastDot) : originalPath;
  const ext = hasExt ? originalPath.slice(lastDot) : "";
  const dev = deviceId ? ` ${deviceId.slice(0, 8)}` : "";
  return `${pathNoExt} (Conflicted Copy ${ts}${dev})${ext}`;
}

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
  const decision = decideUpload(ctx, msg);

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

    // 3. Save healthy files — a conflicting upload is diverted to a
    //    "(Conflicted Copy …)" file instead of overwriting the server head.
    if (!isRejected && decision === "conflict") {
      applyConflict(ctx, peer, file, buf, content);
      msg.content = "";
      advanceUploadQueue(peer, file.path);
      return;
    }
    if (!isRejected && decision === "reject_stale") {
      rejectStaleUpload(ctx, peer, file);
      msg.content = "";
      advanceUploadQueue(peer, file.path);
      return;
    }
    if (!isRejected) {
      ctx.storage.write(file.path, file.mtime, buf);
    }

    // Help the GC clear the buffer promptly
    msg.content = "";
  }

  // Conflict on an upload that carried no content (rare: unreadable file).
  // Keep the server head and just tell the client — nothing to copy.
  if (!isRejected && decision === "conflict") {
    applyConflict(ctx, peer, file, null, "");
    advanceUploadQueue(peer, file.path);
    return;
  }
  if (!isRejected && decision === "reject_stale") {
    rejectStaleUpload(ctx, peer, file);
    advanceUploadQueue(peer, file.path);
    return;
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
  advanceUploadQueue(peer, file.path);
}

/** Pop the next queued upload request and re-check sync completion. */
function advanceUploadQueue(peer: SyncPeer, path: string): void {
  peer.pendingUploads.delete(path);

  if (peer.uploadQueue.length > 0) {
    const next = peer.uploadQueue.shift()!;
    peer.pendingUploads.add(next);
    peer.send({ type: "file_event_result", path: next, result: "client_newer" });
  }

  // Check whether sync is fully complete
  checkSyncDone(peer);
}

/**
 * A concurrent edit was detected: store the client's content as a
 * "(Conflicted Copy …)" file, notify the uploader, distribute the copy to all
 * peers, and re-push the server's current head of the original path so the
 * uploader converges. The server head is never overwritten.
 */
function applyConflict(
  ctx: SyncContext,
  peer: SyncPeer,
  file: FileEntry,
  buf: Buffer | null,
  rawContent: string
): void {
  if (buf) {
    const copyEntry: FileEntry = {
      path: conflictCopyPath(file.path, peer.deviceId),
      sha1: file.sha1,
      mtime: file.mtime,
      action: "active",
      fileType: "file",
    };
    ctx.storage.write(copyEntry.path, copyEntry.mtime, buf);
    ctx.db.upsertFile(copyEntry);
    // Uploader receives the copy directly; broadcastToPeers covers everyone else.
    peer.send({ type: "file_push", file: copyEntry, content: rawContent });
    broadcastToPeers(ctx, peer, copyEntry);
    logWarn(ctx, `[Conflict] ${peer.deviceId} uploaded ${file.path} from a stale base — stored as ${copyEntry.path}`);
    pushActivity(ctx, { kind: "upload", deviceId: peer.deviceId ?? undefined, path: copyEntry.path });
  } else {
    logWarn(ctx, `[Conflict] ${peer.deviceId} uploaded ${file.path} from a stale base with no content — server head kept`);
  }

  peer.send({ type: "file_event_result", path: file.path, result: "conflict" });
  pushHeadToUploader(ctx, peer, file.path);
}

/**
 * Stale hidden/config upload: drop it silently (no copy, no conflict
 * notification — these files flap constantly) and re-push the head so the
 * uploader converges on the winning version.
 */
function rejectStaleUpload(ctx: SyncContext, peer: SyncPeer, file: FileEntry): void {
  logInfo(ctx, `[Conflict] stale config upload dropped (LWW): ${file.path} from ${peer.deviceId}`);
  pushHeadToUploader(ctx, peer, file.path);
}

/** Re-push the server's current head of a path so the uploader's vault converges. */
function pushHeadToUploader(ctx: SyncContext, peer: SyncPeer, path: string): void {
  const serverFile = ctx.db.getFile(path);
  if (serverFile && serverFile.action === "active" && serverFile.fileType === "file") {
    const headBuf = ctx.storage.readLatest(serverFile.path);
    peer.send({ type: "file_push", file: serverFile, content: headBuf ? headBuf.toString("base64") : "" });
  }
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
