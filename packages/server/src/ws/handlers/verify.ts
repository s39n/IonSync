import type { VerifyMissingMsg } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import type { SyncPeer } from "../peer.js";
import { drainPushQueue } from "./sync.js";

/** Manifest entries per verify_manifest chunk. Path+sha1 only, so this is tiny. */
const MANIFEST_CHUNK = 2000;
/** Hard cap on files a single repair request may pull — abuse/runaway guard. */
const MAX_VERIFY_REPAIR = 50_000;

function pushLog(ctx: SyncContext, msg: string): void {
  if (ctx.config.logs.level < 3) return;
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  ctx.logBuffer.push(line);
  if (ctx.logBuffer.length > 200) ctx.logBuffer.shift();
}

/**
 * Completeness audit — the server→client half. Streams the sha1 of every active
 * file so the client can detect anything it's silently missing on disk (the
 * under-fetch that a cursor "caught up" state can hide). Read-only; sends no
 * content. The client replies with `verify_missing` for whatever it lacks.
 */
export function handleVerifyRequest(ctx: SyncContext, peer: SyncPeer): void {
  const manifest = ctx.db.getActiveManifest();
  pushLog(ctx, `[Verify] ${peer.deviceId} manifest requested → ${manifest.length} active files`);

  if (manifest.length === 0) {
    peer.send({ type: "verify_manifest", files: [], last: true });
    return;
  }
  for (let i = 0; i < manifest.length; i += MANIFEST_CHUNK) {
    const slice = manifest.slice(i, i + MANIFEST_CHUNK);
    peer.send({
      type: "verify_manifest",
      files: slice,
      last: i + MANIFEST_CHUNK >= manifest.length,
    });
  }
}

/**
 * Targeted, download-only repair: re-push the requested active paths. Purely
 * additive — it can only send files DOWN to the client, never delete, so a stale
 * or buggy audit can never remove data. Deleted/unknown paths are ignored. Reuses
 * the normal push pipeline (backpressure-aware). No sync_done is emitted because
 * no sync session is active — these arrive as plain file_push and are applied.
 */
export function handleVerifyMissing(ctx: SyncContext, peer: SyncPeer, msg: VerifyMissingMsg): void {
  const paths = Array.isArray(msg.paths) ? msg.paths.slice(0, MAX_VERIFY_REPAIR) : [];
  let queued = 0;
  for (const p of paths) {
    if (typeof p !== "string" || p.length === 0) continue;
    const f = ctx.db.getFile(p);
    if (f && f.action === "active" && f.fileType === "file") {
      peer.pushQueue.push(f);
      queued++;
    }
  }
  pushLog(ctx, `[Verify] ${peer.deviceId} repair: ${queued}/${paths.length} path(s) re-pushed`);
  if (queued > 0) drainPushQueue(ctx, peer);
}
