/**
 * SyncCleanup — runs on an interval and:
 *  1. Trims old content versions per file down to config.versionsPerFile
 *  2. Permanently purges deleted-file records once they're old enough AND
 *     all known devices have come online since the deletion (so they've had a
 *     chance to sync the delete).
 */
import type { SyncContext } from "../context.js";

export class SyncCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private ctx: SyncContext) {}

  start(): void {
    const intervalMs = this.ctx.config.cleanup.intervalSecs * 1_000;
    setTimeout(() => this.run(), 30_000);
    this.timer = setInterval(() => this.run(), intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  run(): void {
    const { config, db, storage } = this.ctx;
    const { versionsPerFile } = config.cleanup;

    // 1. Trim version history
    const allPaths = db.getAllFilePaths();
    let trimmedCount = 0;
    for (const filePath of allPaths) {
      const toTrim = db.getVersionsToTrim(filePath, versionsPerFile);
      if (toTrim.length === 0) continue;
      for (const v of toTrim) {
        storage.deleteVersion(filePath, v.mtime);
      }
      db.pruneVersions(filePath, versionsPerFile);
      trimmedCount += toTrim.length;
    }

    // 2. Hard-delete tombstones every device has already synced past.
    //
    // A deletion is stamped with the seq at which it happened. Once EVERY known
    // device's durable cursor (synced_seq) has passed that seq, they have all
    // seen the deletion (or bootstrapped fresh without the file), so the record
    // can be permanently removed — the server "forgets it ever existed". This
    // replaces the old fixed 7-day wait: it's immediate once devices are caught
    // up, and safe because a delete a device hasn't seen yet has seq greater than
    // that device's synced_seq and is therefore skipped. A stale device that
    // never returns will hold minSynced down and block purging — remove it from
    // the dashboard Devices list to let cleanup proceed.
    const minSynced = db.getMinSyncedSeq();
    const purgeable = db.getDeletedFilesUpToSeq(minSynced);
    for (const file of purgeable) {
      storage.deleteAllVersions(file.path);
      db.deleteFileMeta(file.path);
    }

    if (purgeable.length > 0 || trimmedCount > 0) {
      pushLog(
        this.ctx,
        `[cleanup] trimmed ${trimmedCount} old versions; purged ${purgeable.length} deleted file record(s) (all devices synced past seq ${minSynced === Number.MAX_SAFE_INTEGER ? "∞ (no devices)" : minSynced})`
      );
    }
  }
}

function pushLog(ctx: SyncContext, msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  ctx.logBuffer.push(line);
  if (ctx.logBuffer.length > 200) ctx.logBuffer.shift();
}
