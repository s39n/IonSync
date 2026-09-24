/**
 * One-time move of conflict blobs out of the vault file store.
 *
 * Conflict content used to be stored at `_conflicts/<id>` inside <data>/files —
 * the same namespace as vault paths, so a real vault file at that path
 * overwrote (or was served as) a conflict's losing content. Conflicts now live
 * in their own store (ctx.conflicts, <data>/conflicts). This copies any legacy
 * blobs across on startup. Idempotent: already-migrated ids are skipped.
 */
import fs from "node:fs";
import path from "node:path";
import type { SyncDB } from "./db/index.js";
import type { Storage } from "./storage/index.js";

export function migrateLegacyConflictBlobs(db: SyncDB, files: Storage, conflicts: Storage): number {
  let moved = 0;
  for (const c of db.listConflicts(true)) {
    const legacy = `_conflicts/${c.id}`;
    const key = String(c.id);
    const mtimes = files.listVersionMtimes(legacy);
    if (mtimes.length === 0) continue;

    if (conflicts.listVersionMtimes(key).length === 0) {
      for (const m of mtimes) {
        const buf = files.readVersion(legacy, m);
        if (buf) conflicts.write(key, m, buf);
      }
      moved++;
    }

    // If a real vault file claims this path, its versions share the directory —
    // leave them alone. Otherwise remove the legacy copies (file by file, never
    // recursively, so nothing else under _conflicts/ can be touched).
    if (db.getFile(legacy)) continue;
    for (const m of mtimes) files.deleteVersion(legacy, m);
    try { fs.rmdirSync(path.join(files.root, "_conflicts", key)); } catch { /* not empty / gone */ }
  }
  try { fs.rmdirSync(path.join(files.root, "_conflicts")); } catch { /* not empty / absent */ }
  return moved;
}
