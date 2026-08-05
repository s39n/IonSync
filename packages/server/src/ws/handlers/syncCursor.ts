import type { SyncCursorMsg } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import type { SyncPeer } from "../peer.js";
import { drainPushQueue } from "./sync.js";

/**
 * A batch is capped by BOTH a file count and a total content-byte budget, so
 * only one bounded chunk is ever in flight (sync_done.more drives the next
 * pull). The byte cap matters on low-RAM devices: 250 large PDFs/images would
 * blow the budget even though it's "only" 250 files. A single file larger than
 * the byte cap is still sent alone (capped by the server's 50 MB payload limit).
 */
const MAX_BATCH_COUNT = 250;
const MAX_BATCH_BYTES = 8 * 1024 * 1024; // 8 MB of content per batch

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

  // A from-0 bootstrap must NEVER carry deletions. If a client's cursor outran
  // the server (a DB restore/rebuild rolled the counter back, so `since` was
  // forced to 0 above), replaying the server's diminished state as tombstones
  // would mass-delete a healthy vault — the 2026-08 incident. A genuinely fresh
  // client has an empty vault, so tombstones are no-ops for it anyway. Real
  // deletes still propagate via live vault events and via since>0 deltas; the
  // resurrection bias here matches the audit's safe-by-default stance (S4/S5).
  const includeDeletes = since > 0;

  // Deliver ONE bounded batch — capped by count AND total content bytes. The
  // client applies it then requests the next (driven by sync_done.more), so only
  // one bounded chunk of file content is ever in flight.
  const candidates = ctx.db.getChangesSince(since, MAX_BATCH_COUNT, includeDeletes);
  let bytes = 0;
  let taken = 0;
  for (const c of candidates) {
    const size =
      c.action === "active" && c.fileType === "file"
        ? (ctx.storage.getSizeLatest(c.path) ?? 0)
        : 0;
    // Always take at least one file (else an oversized file would stall sync).
    if (taken > 0 && bytes + size > MAX_BATCH_BYTES) break;
    peer.pushQueue.push(c);
    bytes += size;
    taken++;
  }

  // `more` when we stopped early (byte cap) or filled the count cap — there may
  // be further changes; the client re-requests with the returned cursor. When
  // fully drained, report the current counter so the client is caught up (covers
  // counter gaps left by purges).
  const more = taken < candidates.length || candidates.length === MAX_BATCH_COUNT;
  peer.cursorTarget = more ? candidates[taken - 1]!.seq : current;
  peer.syncMore = more;
  peer.syncSessionActive = true;

  pushLog(
    ctx,
    `[CursorSync] ${peer.deviceId} since=${since} → ${taken} change(s), ${(bytes / 1024).toFixed(0)}KB${more ? " (more)" : ""}, cursor→${peer.cursorTarget}`
  );

  // Streams file_push (each with its seq), then sync_done { cursor, more }. An
  // empty queue resolves straight to sync_done via checkSyncDone.
  drainPushQueue(ctx, peer);
}
