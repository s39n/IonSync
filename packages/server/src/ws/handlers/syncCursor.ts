import type { SyncCursorMsg } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import type { SyncPeer } from "../peer.js";
import { drainPushQueue } from "./sync.js";

/**
 * Max changes delivered per sync_cursor request. The client applies a batch
 * then asks for the next (sync_done.more = true), so only one batch of file
 * contents is ever in flight — this bounds peak memory during a large bootstrap
 * on low-RAM devices instead of firehosing the whole vault at once.
 */
const BATCH = 250;

function pushLog(ctx: SyncContext, msg: string): void {
  if (ctx.config.logs.level < 3) return;
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  ctx.logBuffer.push(line);
  if (ctx.logBuffer.length > 200) ctx.logBuffer.shift();
}

/**
 * Cursor-based delta sync (phase 1) — the server→client (download) direction.
 *
 * The client sends the highest seq it has applied; the server replays every
 * change with `seq > since` as `file_push` messages (active files with content,
 * deletions/tombstones with empty content), then `sync_done { cursor }`.
 *
 * Unlike the legacy `handleSync`, there is no upload reconciliation here: the
 * client's own offline edits flow up separately as real-time `file_data`
 * uploads. This handler only catches the client up on what changed server-side.
 */
export function handleSyncCursor(ctx: SyncContext, peer: SyncPeer, msg: SyncCursorMsg): void {
  // Cursor sync is download-only — clear any prior/partial session state.
  peer.pendingUploads.clear();
  peer.uploadQueue = [];
  peer.pushQueue = [];
  delete peer.syncClientMap;

  const current = ctx.db.getCurrentSeq();

  // Validate `since`. A cursor ahead of the server (e.g. after a DB restore
  // rolled the counter back) would under-fetch, so force a full bootstrap.
  let since = Number.isFinite(msg.since) ? Math.max(0, Math.floor(msg.since)) : 0;
  if (since > current) {
    pushLog(ctx, `[CursorSync] ${peer.deviceId} cursor ${since} > server ${current} — forcing bootstrap`);
    since = 0;
  }

  // Deliver ONE bounded batch. The client applies it then requests the next
  // (driven by sync_done.more), so only one batch of file contents is ever in
  // flight — this caps peak memory on the receiving device.
  const changes = ctx.db.getChangesSince(since, BATCH);
  for (const c of changes) peer.pushQueue.push(c);

  // `more` is true when this batch was full — there may be further changes. The
  // client re-requests with the new cursor. When done, advance the reported
  // cursor to the current counter so the client is fully caught up (covers
  // counter gaps left by purges).
  const more = changes.length === BATCH;
  peer.cursorTarget = more ? changes[changes.length - 1]!.seq : current;
  peer.syncMore = more;
  peer.syncSessionActive = true;

  pushLog(
    ctx,
    `[CursorSync] ${peer.deviceId} since=${since} → ${changes.length} change(s)${more ? " (more)" : ""}, cursor→${peer.cursorTarget}`
  );

  // Streams file_push (each with its seq), then sync_done { cursor, more }. An
  // empty queue resolves straight to sync_done via checkSyncDone.
  drainPushQueue(ctx, peer);
}
