import type {
  ConflictListRequestMsg,
  ConflictContentRequestMsg,
  ConflictResolveMsg,
  ConflictRestoreMsg,
  FileEntry,
} from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import { pushActivity } from "../../context.js";
import type { SyncPeer } from "../peer.js";
import { broadcastToPeers } from "./sync.js";
import { isE2eeEncrypted } from "../../e2ee.js";

/**
 * Conflict management over WebSocket — the same operations the dashboard's
 * Conflicts panel performs (/api/conflicts, /api/conflict-content,
 * /api/conflict-resolve, /api/conflict-restore), exposed to authenticated
 * plugin peers so conflicts can be reviewed and resolved from inside Obsidian.
 */

export function handleConflictList(
  ctx: SyncContext,
  peer: SyncPeer,
  _msg: ConflictListRequestMsg
): void {
  const conflicts = ctx.db.listConflicts(false).map((c) => ({
    id: c.id,
    path: c.path,
    sha1: c.sha1,
    mtime: c.mtime,
    createdAt: c.createdAt,
    deviceName: c.deviceId
      ? (ctx.db.getDeviceName(c.deviceId) ?? c.deviceId.slice(0, 8))
      : null,
  }));
  peer.send({ type: "conflict_list_response", conflicts });
}

export function handleConflictContent(
  ctx: SyncContext,
  peer: SyncPeer,
  msg: ConflictContentRequestMsg
): void {
  const c = ctx.db.getConflict(msg.id);
  if (!c) {
    peer.send({ type: "conflict_content_response", id: msg.id, path: "", content: "", encrypted: false, found: false });
    return;
  }
  const buf = ctx.storage.readLatest(`_conflicts/${c.id}`);
  peer.send({
    type: "conflict_content_response",
    id: c.id,
    path: c.path,
    content: buf ? buf.toString("base64") : "",
    encrypted: buf ? isE2eeEncrypted(buf) : false,
    found: !!buf,
  });
}

export function handleConflictResolve(
  ctx: SyncContext,
  peer: SyncPeer,
  msg: ConflictResolveMsg
): void {
  const c = ctx.db.getConflict(msg.id);
  if (!c) {
    peer.send({ type: "conflict_action_response", id: msg.id, action: "resolve", ok: false, error: "Unknown conflict" });
    return;
  }
  ctx.db.resolveConflict(msg.id);
  peer.send({ type: "conflict_action_response", id: msg.id, action: "resolve", ok: true, path: c.path });
}

export function handleConflictRestore(
  ctx: SyncContext,
  peer: SyncPeer,
  msg: ConflictRestoreMsg
): void {
  const c = ctx.db.getConflict(msg.id);
  if (!c) {
    peer.send({ type: "conflict_action_response", id: msg.id, action: "restore", ok: false, error: "Unknown conflict" });
    return;
  }
  const buf = ctx.storage.readLatest(`_conflicts/${c.id}`);
  if (!buf) {
    peer.send({ type: "conflict_action_response", id: msg.id, action: "restore", ok: false, error: "Conflict content missing" });
    return;
  }
  // Promote the losing content to the current head, then broadcast to EVERY peer
  // (sourcePeer = null, no exclusion) so all devices — including the requester,
  // whose vault still holds the winning version — pull the restored content.
  const entry: FileEntry = { path: c.path, sha1: c.sha1, mtime: Date.now(), action: "active", fileType: "file" };
  ctx.storage.write(c.path, entry.mtime, buf);
  ctx.db.upsertFile(entry, buf.length, null);
  ctx.db.resolveConflict(msg.id);
  broadcastToPeers(ctx, null, entry);
  pushActivity(ctx, { kind: "upload", deviceId: peer.deviceId ?? undefined, path: c.path });
  peer.send({ type: "conflict_action_response", id: msg.id, action: "restore", ok: true, path: c.path });
}
