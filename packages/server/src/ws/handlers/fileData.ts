import type { FileDataUploadMsg, FileDataRequestMsg, FileConflictMsg, FileEntry } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import { pushActivity } from "../../context.js";
import type { SyncPeer } from "../peer.js";
import { broadcastToPeers, checkSyncDone } from "./sync.js";
import { isE2eeEncrypted, e2eeVersion } from "../../e2ee.js";
import crypto from "node:crypto";

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
function decideUpload(
  ctx: SyncContext,
  msg: FileDataUploadMsg
): "accept" | "conflict" | "reject_stale" | "structural_conflict" {
  const { file, baseSha1 } = msg;
  if (file.action !== "active" || file.fileType !== "file") return "accept";

  const serverFile = ctx.db.getFile(file.path);
  if (!serverFile) return "accept";
  if (serverFile.action === "deleted") {
    // A plain delete → an upload is a re-add (accept). If the old path was
    // retired by a *rename* (renamed_to set), an upload to it MAY be an edit
    // that raced the rename — a structural conflict against the rename target.
    // Only a client that actually HAD the pre-rename file can race the rename:
    // such an upload carries a baseSha1 (the sha it last synced for this path).
    // A brand-new create with no baseSha1 is a new note that merely reuses a
    // recycled name (e.g. "Untitled 1.md", whose earlier incarnation was renamed
    // away) — it is a re-add, not a race, and must NOT be diverted into a
    // conflict copy or it would close the note out from under the editor.
    const renamedTo = ctx.db.getRenameTarget(file.path);
    const hasBase = baseSha1 !== undefined && baseSha1 !== "";
    if (hasBase && renamedTo && !isHiddenOrConfigPath(file.path)) return "structural_conflict";
    return "accept";
  }
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

/**
 * True for paths the sync treats as hidden/config (LWW, never a conflict copy).
 *
 * Matches any dot-segment (".obsidian/app.json", "foo/.hidden/x") AND the DOS
 * 8.3 short-name twin of the config folder: "OBSIDI~1". A recovery/restore tool
 * that walked the disk via short paths can create a literal "OBSIDI~1" folder
 * beside ".obsidian"; it has no dot segment, so without this it dodged the
 * carve-out and its plugin data.json files minted a conflict copy on every flap
 * (observed in production — thousands of junk copies). Treat it as config so it
 * resolves by last-write-wins instead.
 */
export function isHiddenOrConfigPath(p: string): boolean {
  return p.startsWith(".") || p.includes("/.") || isShortNameConfigDir(p);
}

/** True if any path segment is the 8.3 short-name alias of ".obsidian". */
export function isShortNameConfigDir(p: string): boolean {
  return /(^|\/)OBSIDI~\d+(\/|$)/i.test(p);
}

/**
 * True when an uploaded buffer carries no real content. Plain files: zero bytes.
 * E2EE files: the ciphertext of empty plaintext is exactly MAGIC(8) + IV(12) +
 * GCM tag(16) = 36 bytes, so an encrypted blob of 36 bytes or fewer is empty.
 *
 * Used so a CONFLICTING upload with no content is never stored as an empty
 * "(Conflicted Copy …)" stub: there is nothing to preserve, and a damaged or
 * freshly-restored device that re-uploads empty/truncated files would otherwise
 * litter every device with empty copies (observed after a backup restore). The
 * server head (which has the real content) is kept and re-pushed instead.
 */
export function isEmptyUpload(buf: Buffer): boolean {
  if (isE2eeEncrypted(buf)) return buf.length <= 36;
  return buf.length === 0;
}

/**
 * True when an accepted upload is a byte-meaningless resend of the current
 * head: same sha1, same active state — nothing any peer needs to hear about.
 * Storing it would append a duplicate version row, move the head mtime/seq,
 * and broadcast the note straight back to the device that's actively editing
 * it — echo amplification (the July 2026 conflict-copy storm).
 *
 * Two exceptions where the plaintext sha is unchanged but the bytes must still
 * be stored:
 *   - E2EE upload over a plaintext-stored head — the encryption *upgrade* path
 *     (plugin re-uploads the same plaintext sha as ciphertext).
 *   - E2EE upload whose ciphertext FORMAT VERSION differs from the stored head
 *     (e.g. v2 global salt → v3 per-install salt, SECURITY.md #7) — the re-key
 *     migration. Without this the "Re-encrypt all files" re-upload of an
 *     already-encrypted note is dropped and the note never moves to v3.
 * Conversely a plaintext resend over a ciphertext head is skipped — which also
 * prevents accidental encryption downgrades.
 */
function isNoopResend(ctx: SyncContext, file: FileEntry, isE2EE: boolean, uploadBuf: Buffer): boolean {
  if (file.action !== "active" || file.fileType !== "file" || !file.sha1) return false;
  const head = ctx.db.getFile(file.path);
  if (!head || head.action !== "active" || head.sha1 !== file.sha1) return false;
  if (isE2EE) {
    const headBuf = ctx.storage.readLatest(file.path);
    if (!headBuf || !isE2eeEncrypted(headBuf)) return false; // plaintext→ciphertext upgrade: store it
    // Re-key: same plaintext, but the stored ciphertext is a different format
    // version — store it so the migration actually replaces the blob.
    if (e2eeVersion(headBuf) !== e2eeVersion(uploadBuf)) return false;
  }
  return true;
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
  let savedSize: number | undefined;
  const decision = decideUpload(ctx, msg);

  // Persist content for active files (not folders, not deleted).
  // Binary-frame uploads arrive as raw bytes (msg.contentBytes) — no base64
  // decode needed; legacy uploads still carry base64 in `content`.
  const hasBytes = msg.contentBytes !== undefined && msg.contentBytes.length > 0;
  if (file.action === "active" && file.fileType === "file" && (content || hasBytes)) {
    const buf = hasBytes
      ? Buffer.from(msg.contentBytes!.buffer, msg.contentBytes!.byteOffset, msg.contentBytes!.byteLength)
      : Buffer.from(content, "base64");

    // Detect E2EE: the plugin prepends an 8-byte magic header ("IONENCv<N>")
    // to every encrypted payload.  When present the SHA1 in the file entry
    // is of the *plaintext* (not the ciphertext), so we must skip the SHA1
    // check -- the server can't verify content it cannot decrypt.
    isE2EE = isE2eeEncrypted(buf);

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
      applyConflict(ctx, peer, file, buf);
      clearUploadContent(msg);
      advanceUploadQueue(peer, file.path);
      return;
    }
    if (!isRejected && decision === "reject_stale") {
      rejectStaleUpload(ctx, peer, file);
      clearUploadContent(msg);
      advanceUploadQueue(peer, file.path);
      return;
    }
    if (!isRejected && decision === "structural_conflict") {
      applyStructuralConflict(ctx, peer, file, buf);
      clearUploadContent(msg);
      advanceUploadQueue(peer, file.path);
      return;
    }
    // No-op resend of the current head: drop it before it touches the DB or
    // any peer. See isNoopResend — this is the echo-amplification cut.
    if (!isRejected && decision === "accept" && isNoopResend(ctx, file, isE2EE, buf)) {
      logInfo(ctx, `[file_data] no-op resend of ${file.path} (sha unchanged) — dropped, no broadcast`);
      clearUploadContent(msg);
      advanceUploadQueue(peer, file.path);
      return;
    }
    if (!isRejected) {
      ctx.storage.write(file.path, file.mtime, buf);
      savedSize = buf.length;
    }

    // Help the GC clear the buffer promptly
    clearUploadContent(msg);
  }

  // Conflict on an upload that carried no content (rare: unreadable file).
  // Keep the server head and just tell the client — nothing to copy.
  if (!isRejected && decision === "conflict") {
    applyConflict(ctx, peer, file, null);
    advanceUploadQueue(peer, file.path);
    return;
  }
  if (!isRejected && decision === "reject_stale") {
    rejectStaleUpload(ctx, peer, file);
    advanceUploadQueue(peer, file.path);
    return;
  }
  if (!isRejected && decision === "structural_conflict") {
    applyStructuralConflict(ctx, peer, file, null);
    advanceUploadQueue(peer, file.path);
    return;
  }

  // Only update the database and broadcast if the file was ACTUALLY saved
  if (!isRejected) {
    ctx.db.upsertFile(file, savedSize, peer.deviceId ?? null);
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
 * Preserve the LOSING side of a conflict as a reviewable server-side record
 * instead of a "(Conflicted Copy …)" file: store its bytes under the dedicated
 * storage key `_conflicts/<id>` (isolated from the file's version history, so it
 * can never become `readLatest`) and index it in the `conflicts` table. The head
 * is never touched and nothing is broadcast — no copy appears in any vault.
 * Empty/no content is dropped (nothing worth preserving).
 */
export function storeConflict(
  ctx: SyncContext,
  peer: SyncPeer,
  path: string,
  sha1: string,
  mtime: number,
  buf: Buffer | null
): void {
  if (!buf || isEmptyUpload(buf)) {
    logWarn(ctx, `[Conflict] ${peer.deviceId} conflict on ${path} with ${buf ? "empty" : "no"} content — head kept, nothing recorded`);
    return;
  }
  const id = ctx.db.recordConflict(path, sha1, mtime, peer.deviceId ?? null);
  ctx.storage.write(`_conflicts/${id}`, mtime, buf);
  logWarn(ctx, `[Conflict] ${peer.deviceId} conflict on ${path} — recorded as conflict #${id} (${buf.length}b), head kept`);
  pushActivity(ctx, { kind: "conflict", deviceId: peer.deviceId ?? undefined, path });
}

/**
 * A concurrent edit was detected on an upload: preserve the client's (losing)
 * content as a conflict record, tell the uploader, and re-push the server's
 * current head so the uploader converges. The head is never overwritten.
 */
function applyConflict(
  ctx: SyncContext,
  peer: SyncPeer,
  file: FileEntry,
  buf: Buffer | null
): void {
  storeConflict(ctx, peer, file.path, file.sha1, file.mtime, buf);
  peer.send({ type: "file_event_result", path: file.path, result: "conflict" });
  pushHeadToUploader(ctx, peer, file.path);
}

/**
 * Client is preserving its own losing side of a conflict (mode:"conflict") —
 * the offline edit it made that the incoming server version beat. Record it;
 * never touch the head or broadcast.
 */
export function handleConflictUpload(ctx: SyncContext, peer: SyncPeer, msg: FileConflictMsg): void {
  const { file } = msg;
  const hasBytes = msg.contentBytes !== undefined && msg.contentBytes.length > 0;
  const buf = hasBytes
    ? Buffer.from(msg.contentBytes!.buffer, msg.contentBytes!.byteOffset, msg.contentBytes!.byteLength)
    : (msg.content ? Buffer.from(msg.content, "base64") : null);
  storeConflict(ctx, peer, file.path, file.sha1, file.mtime, buf);
  msg.content = "";
  delete msg.contentBytes;
}

/**
 * An upload targeted a path that was renamed away on another device — the
 * uploader edited `from` concurrently with A's rename `from → to`. The server
 * never touches the rename target's head. Instead:
 *   - if the upload's content already equals the target head, there is no real
 *     divergence → just converge the uploader (delete old path, adopt target);
 *   - otherwise preserve the edit as a "(Conflicted Copy …)" beside the target,
 *     broadcast it, tell the uploader (`structural_conflict`), and converge it.
 */
function applyStructuralConflict(
  ctx: SyncContext,
  peer: SyncPeer,
  file: FileEntry,
  buf: Buffer | null
): void {
  const renamedTo = ctx.db.getRenameTarget(file.path);
  if (!renamedTo) {
    // Rename metadata vanished between decision and here (concurrent purge).
    // Fall back to accepting the upload as a re-add so no edit is lost.
    if (buf) {
      ctx.storage.write(file.path, file.mtime, buf);
      ctx.db.upsertFile(file, buf.length);
      broadcastToPeers(ctx, peer, file);
    }
    return;
  }

  const target = ctx.db.getFile(renamedTo);

  // No real divergence: the uploader's content already matches the rename
  // target's head. Don't mint a copy — just converge the uploader.
  if (buf && target && target.action === "active" && file.sha1 && file.sha1 === target.sha1) {
    logInfo(ctx, `[Structural] ${peer.deviceId} re-sent ${file.path} == head of renamed target ${renamedTo} — converging, no copy`);
    pushRenameConvergence(ctx, peer, file.path, renamedTo);
    return;
  }

  // Preserve the losing edit as a conflict record against the rename TARGET
  // (where the content now belongs), instead of a "(Conflicted Copy ...)" file.
  storeConflict(ctx, peer, renamedTo, file.sha1, file.mtime, buf);

  peer.send({ type: "file_event_result", path: file.path, result: "structural_conflict", renamedTo });
  pushRenameConvergence(ctx, peer, file.path, renamedTo);
}

/**
 * Bring an uploader in line after a rename it hadn't seen: push the old path's
 * deletion tombstone and the rename target's current head so its vault ends up
 * with the file at the new location.
 */
function pushRenameConvergence(ctx: SyncContext, peer: SyncPeer, fromPath: string, toPath: string): void {
  const tombstone = ctx.db.getFile(fromPath);
  if (tombstone && tombstone.action === "deleted") {
    peer.send({ type: "file_push", file: tombstone, content: "" });
  }
  const target = ctx.db.getFile(toPath);
  if (target && target.action === "active" && target.fileType === "file") {
    const headBuf = ctx.storage.readLatest(toPath);
    peer.send({ type: "file_push", file: target, content: "", ...(headBuf ? { contentBytes: headBuf } : {}) });
  }
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
    peer.send({ type: "file_push", file: serverFile, content: "", ...(headBuf ? { contentBytes: headBuf } : {}) });
  }
}

/** Release upload payload references (base64 string + raw byte view) so the GC
 *  can reclaim them promptly after the upload is handled. */
function clearUploadContent(msg: FileDataUploadMsg): void {
  msg.content = "";
  delete msg.contentBytes;
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
    const isEncrypted = isE2eeEncrypted(buf);
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
