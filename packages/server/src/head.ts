/**
 * Resolving a file's stored bytes from its DB record.
 *
 * Versions are stored on disk as v_<mtime> with the mtime supplied by the
 * uploading device. "Highest mtime on disk" is therefore NOT "current head":
 * one device with a fast clock would pin its old version as "latest" and every
 * later (accepted) edit would be served with that stale content. These helpers
 * locate the version by the head's sha1 via the version table instead, falling
 * back to the newest-on-disk only for legacy paths with no version rows.
 */
import type { SyncContext } from "./context.js";

/** Storage mtime of the version holding `sha1` (default: the head's sha1). */
export function versionMtimeFor(ctx: SyncContext, filePath: string, sha1?: string): number | null {
  const m = ctx.db.getVersionMtimeForSha(filePath, sha1);
  if (m !== null && ctx.storage.getSizeVersion(filePath, m) !== null) return m;
  if (sha1 !== undefined) {
    // The requested sha may have been trimmed; serve the current head instead.
    const head = ctx.db.getVersionMtimeForSha(filePath);
    if (head !== null && ctx.storage.getSizeVersion(filePath, head) !== null) return head;
  }
  return ctx.storage.latestVersionMtime(filePath);
}

/** Bytes of the version holding `sha1` (default: the current head). */
export function readHead(ctx: SyncContext, filePath: string, sha1?: string): Buffer | null {
  const m = versionMtimeFor(ctx, filePath, sha1);
  return m === null ? null : ctx.storage.readVersion(filePath, m);
}

/** Size in bytes of the version holding `sha1` (default: the current head). */
export function headSize(ctx: SyncContext, filePath: string, sha1?: string): number | null {
  const m = versionMtimeFor(ctx, filePath, sha1);
  return m === null ? null : ctx.storage.getSizeVersion(filePath, m);
}
