import fs from "node:fs";
import path from "node:path";

/**
 * SQLite backups for the sync DB. Snapshots use `VACUUM INTO`, which writes a
 * consistent, compacted, single-file copy synchronously and is WAL-safe — no
 * need to stop the server or copy the -wal/-shm sidecars. The DB holds only
 * metadata (files/versions/conflicts/settings — file *content* lives on disk
 * under data/files), so snapshots are small.
 *
 * Two kinds, both under data/backups/:
 *   - `pre-migrate` — taken on startup before migrations run (rollback point if
 *     a migration or startup logic corrupts data — the cause of both incidents).
 *   - `daily` — taken on a timer while running.
 * Retention is per-kind (default 7 each).
 */

export function backupFilename(tag: string, when = new Date()): string {
  const stamp = when.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `sync-${tag}-${stamp}.db`;
}

/** Keep only the newest `retain` snapshots for a tag. Timestamped names sort
 *  chronologically, so a lexical sort is chronological. */
export function pruneBackups(dir: string, tag: string, retain: number): void {
  try {
    const prefix = `sync-${tag}-`;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".db"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - retain))) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {
    /* dir missing / unreadable — nothing to prune */
  }
}

export interface ScheduleOptions {
  intervalMs: number;
  retain: number;
}

/**
 * Run `snapshot(dir, "daily")` on a timer. `snapshot` is injected (SyncDB.snapshot)
 * so this module stays decoupled from the DB layer. Returns a stop function.
 * The timer is unref'd so it never keeps the process alive on shutdown.
 */
export function startBackupScheduler(
  snapshot: (dir: string, tag: string) => string,
  dir: string,
  opts: ScheduleOptions,
): () => void {
  const run = (): void => {
    try {
      const p = snapshot(dir, "daily");
      pruneBackups(dir, "daily", opts.retain);
      console.log(`[backup] daily snapshot → ${path.basename(p)}`);
    } catch (e) {
      console.error("[backup] scheduled snapshot failed:", e);
    }
  };
  const timer = setInterval(run, opts.intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  return () => clearInterval(timer);
}
