/**
 * Validation for vault paths arriving from clients.
 *
 * Storage maps a vault path straight onto a directory under <data>/files, so a
 * path must name a real file *inside* that tree. Storage.resolve already blocks
 * escapes (`../x`), but it still accepted paths that resolve to the storage
 * root itself or alias another path: "." (or "a/..") resolves to the root, so
 * purging such a record ran `rm -rf` over every stored note. Reject anything
 * that isn't a plain, normalised, relative path.
 */

/** Longest path accepted (bytes of UTF-16; generous — segments are capped by the FS). */
export const MAX_VAULT_PATH_LENGTH = 1024;

export function isValidVaultPath(p: unknown): p is string {
  if (typeof p !== "string") return false;
  if (p.length === 0 || p.length > MAX_VAULT_PATH_LENGTH) return false;
  if (p.includes("\0") || p.includes("\\")) return false;
  if (p.startsWith("/")) return false;
  for (const seg of p.split("/")) {
    // Empty segment = leading/trailing/double slash; "." and ".." alias or escape.
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}
