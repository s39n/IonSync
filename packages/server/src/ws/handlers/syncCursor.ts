import type { SyncCursorMsg } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import type { SyncPeer } from "../peer.js";
import { drainPushQueue } from "./sync.js";

/** Change rows gathered from the DB per loop iteration before draining. */
const GATHER_BATCH = 5000;

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

  // Gather every change since the cursor synchronously. Doing the whole gather
  // in one run (no event-loop yield) means no concurrent write can interleave
  // and leave a gap between what we read and the cursor we report.
  let cursor = since;
  for (;;) {
    const changes = ctx.db.getChangesSince(cursor, GATHER_BATCH);
    if (changes.length === 0) break;
    for (const c of changes) peer.pushQueue.push(c);
    cursor = changes[changes.length - 1]!.seq;
    if (changes.length < GATHER_BATCH) break;
  }

  // Report the server's current counter as the new cursor. The client receives
  // everything up to max(files.seq) through this feed; any change above that
  // (or one that lands live during the drain) arrives as a live `file_push`
  // carrying its own seq, which the client also folds into its stored cursor.
  peer.cursorTarget = current;
  peer.syncSessionActive = true;

  pushLog(
    ctx,
    `[CursorSync] ${peer.deviceId} since=${since} → ${peer.pushQueue.length} change(s), cursor→${current}`
  );

  // Streams file_push (each with its seq), then sync_done { cursor }. An empty
  // queue resolves straight to sync_done via checkSyncDone.
  drainPushQueue(ctx, peer);
}
