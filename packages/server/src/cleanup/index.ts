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
    const { versionsPerFile, keepDeletedFilesSecs } = config.cleanup;

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

    // 2. Purge expired deleted-file records
    const cutoff = Date.now() - keepDeletedFilesSecs * 1_000;
    const oldestDeviceOnline = db.getOldestDeviceOnline();

    if (oldestDeviceOnline < cutoff) {
      if (trimmedCount > 0) {
        pushLog(this.ctx, `[cleanup] trimmed ${trimmedCount} old versions`);
      }
      return;
    }

    const expired = db.getExpiredDeletedFiles(cutoff);
    for (const file of expired) {
      storage.deleteAllVersions(file.path);
      db.deleteFileMeta(file.path);
    }

    if (expired.length > 0 || trimmedCount > 0) {
      pushLog(
        this.ctx,
        `[cleanup] trimmed ${trimmedCount} old versions; purged ${expired.length} deleted files`
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
