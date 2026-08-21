import type { FileRenameMsg, FileEntry } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import { pushActivity } from "../../context.js";
import type { SyncPeer } from "../peer.js";
import { broadcastToPeers } from "./sync.js";
import { isHiddenOrConfigPath, storeConflict } from "./fileData.js";

/**
 * Client renamed/moved a path as one atomic operation (`file_rename`), instead
 * of the legacy delete(from)+create(to) decomposition. Handling it as a unit
 * lets us relink version history in one step and — crucially — detect a
 * STRUCTURAL conflict: a concurrent content edit of `from` on another device.
 *
 * Resolution rule (order-independent): the rename always completes to `to`; a
 * concurrent edit of `from` is never destroyed — it is preserved as a
 * "(Conflicted Copy …)" beside `to`. The mirror image (an edit that arrives
 * *after* the rename) is caught by the rename-tombstone branch in
 * `decideUpload` → `applyStructuralConflict` (handlers/fileData.ts).
 */
export function handleRename(ctx: SyncContext, peer: SyncPeer, msg: FileRenameMsg): void {
  const { from, to, sha1, baseSha1, fileType } = msg;
  if (from === to) return;

  if (fileType === "folder") {
    handleFolderRename(ctx, peer, from, to);
    return;
  }

  const serverFrom = ctx.db.getFile(from);

  // (1) `from` is unknown or already gone — we cannot relink. Fall back to
  //     treating `to` as an ordinary file: pull it unless the server already
  //     holds that exact content (idempotent replay of a rename we processed).
  if (!serverFrom || serverFrom.action !== "active") {
    const serverTo = ctx.db.getFile(to);
    if (!serverTo || serverTo.action !== "active" || serverTo.sha1 !== sha1) {
      requestUpload(peer, to);
    }
    return;
  }

  const hidden = isHiddenOrConfigPath(from) || isHiddenOrConfigPath(to);
  const concurrent =
    baseSha1 !== undefined && baseSha1 !== "" && baseSha1 !== serverFrom.sha1 && !hidden;

  // (2) STRUCTURAL CONFLICT: the head of `from` moved since the client based its
  //     rename on it — someone edited `from` concurrently. Preserve that edit
  //     (the current `from` head) as a conflicted copy of `to`, complete the
  //     rename, and pull the initiator's own `to` content to overwrite it.
  if (concurrent) {
    // Preserve the concurrent edit (the current `from` head) as a conflict
    // record against `to`, instead of a "(Conflicted Copy ...)" file.
    storeConflict(ctx, peer, to, serverFrom.sha1, serverFrom.mtime, ctx.storage.readLatest(from));
    completeRename(ctx, from, to);
    broadcastDelete(ctx, peer, from);
    requestUpload(peer, to); // initiator uploads its `to` content (the renamed version)
    peer.send({ type: "file_event_result", path: from, result: "structural_conflict", renamedTo: to });
    logInfo(ctx, `[Rename] ${peer.deviceId} structural conflict ${from}→${to}`);
    return;
  }

  // (3) Clean rename (no concurrent edit).
  completeRename(ctx, from, to);
  broadcastDelete(ctx, peer, from);

  if (sha1 !== serverFrom.sha1) {
    // Rename + an unsynced local edit: the relinked `to` still holds the OLD
    // bytes; pull the new content from the initiator. Peers learn of `to` when
    // that upload lands and broadcasts.
    requestUpload(peer, to);
    logInfo(ctx, `[Rename] ${peer.deviceId} rename+edit ${from}→${to} (pulling new content)`);
  } else {
    // Pure move: relinked bytes are already correct. Push `to` to other peers.
    broadcastActive(ctx, peer, to);
    logInfo(ctx, `[Rename] ${peer.deviceId} pure move ${from}→${to}`);
  }
}

/**
 * Folder rename: relink every child path (DB + storage) and re-broadcast each as
 * delete(old)+push(new) to other peers. No structural-conflict detection at the
 * folder level (a concurrent child edit still flows through the per-file gate).
 */
function handleFolderRename(ctx: SyncContext, peer: SyncPeer, from: string, to: string): void {
  const pairs = ctx.storage.renameFolder(from, to); // {oldPath,newPath}[] — moves disk
  ctx.db.renameFolderPaths(from, to); // relink DB rows + tombstones
  for (const { oldPath, newPath } of pairs) {
    broadcastDelete(ctx, peer, oldPath);
    broadcastActive(ctx, peer, newPath);
  }
  logInfo(ctx, `[Rename] ${peer.deviceId} folder ${from}→${to} (${pairs.length} file(s))`);
  pushActivity(ctx, { kind: "rename", deviceId: peer.deviceId ?? undefined, detail: `${from} => ${to}` });
}

/** DB relink (history move + tombstone with renamed_to) paired with the disk move. */
function completeRename(ctx: SyncContext, from: string, to: string): void {
  ctx.db.renameFilePath(from, to);
  ctx.storage.renameFile(from, to);
}

/** Ask the initiator to upload the current content of `path`. */
function requestUpload(peer: SyncPeer, path: string): void {
  peer.pendingUploads.add(path);
  peer.send({ type: "file_event_result", path, result: "client_newer" });
}

/** Broadcast the deletion tombstone of `path` to all other peers. */
function broadcastDelete(ctx: SyncContext, peer: SyncPeer, path: string): void {
  const tombstone = ctx.db.getFile(path);
  if (tombstone && tombstone.action === "deleted") broadcastToPeers(ctx, peer, tombstone);
}

/** Broadcast the active head of `path` to all other peers. */
function broadcastActive(ctx: SyncContext, peer: SyncPeer, path: string): void {
  const file = ctx.db.getFile(path);
  if (file && file.action === "active" && file.fileType === "file") broadcastToPeers(ctx, peer, file);
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
