/**
 * Path rules for the LLM API. Stricter than the sync server's: an API caller
 * may only touch ordinary, visible vault files, never `.obsidian/**` or any
 * other dot-path (plugin code, app config, the trash).
 */

export const MAX_VAULT_PATH_LENGTH = 1024;

/** Same shape rules as server/src/paths.ts — keep the two in step. */
export function isValidVaultPath(p: unknown): p is string {
  if (typeof p !== "string") return false;
  if (p.length === 0 || p.length > MAX_VAULT_PATH_LENGTH) return false;
  if (p.includes("\0") || p.includes("\\")) return false;
  if (p.startsWith("/")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

/** Hidden/config paths (mirrors isHiddenOrConfigPath in the server). */
export function isHiddenPath(p: string): boolean {
  return p.startsWith(".") || p.includes("/.") || /(^|\/)OBSIDI~\d+(\/|$)/i.test(p);
}

/** Extensions whose content is kept in memory, searched, and writable. */
const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "txt", "canvas", "base", "csv", "tsv", "json", "yaml", "yml",
  "org", "tex", "html", "css", "js", "ts",
]);

export function isTextPath(p: string): boolean {
  const name = p.slice(p.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
