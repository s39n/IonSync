import { test } from "node:test";
import assert from "node:assert/strict";
import { collectFolderChildren } from "@ionsync/protocol";
import type { FileEntry } from "@ionsync/protocol";

function file(path: string, action: "active" | "deleted" = "active"): FileEntry {
  return { path, sha1: "x", mtime: 1, action, fileType: "file" };
}

test("collectFolderChildren returns every active file under a folder", () => {
  const meta: Record<string, FileEntry> = {
    "Projects/a.md": file("Projects/a.md"),
    "Projects/sub/b.md": file("Projects/sub/b.md"),
    "Projects/sub/c.png": file("Projects/sub/c.png"),
    "Other/d.md": file("Other/d.md"),
  };
  const children = collectFolderChildren("Projects", meta).sort();
  assert.deepEqual(children, [
    "Projects/a.md",
    "Projects/sub/b.md",
    "Projects/sub/c.png",
  ]);
});

test("collectFolderChildren skips already-deleted children (re-delete is a no-op)", () => {
  const meta: Record<string, FileEntry> = {
    "Projects/a.md": file("Projects/a.md", "deleted"),
    "Projects/b.md": file("Projects/b.md", "active"),
  };
  assert.deepEqual(collectFolderChildren("Projects", meta), ["Projects/b.md"]);
});

test("collectFolderChildren does not match sibling paths that share a prefix", () => {
  // A plain file delete must not sweep siblings whose names start the same way.
  const meta: Record<string, FileEntry> = {
    "notes/foo.md": file("notes/foo.md"),
    "notes/foobar.md": file("notes/foobar.md"),
    "notes/foo/child.md": file("notes/foo/child.md"),
  };
  // Deleting the FILE "notes/foo.md" — the "/" guard means no children match.
  assert.deepEqual(collectFolderChildren("notes/foo.md", meta), []);
  // Deleting the FOLDER "notes/foo" — only its real child, not "foobar.md".
  assert.deepEqual(collectFolderChildren("notes/foo", meta), ["notes/foo/child.md"]);
});

test("collectFolderChildren returns empty for a folder with no tracked files", () => {
  assert.deepEqual(collectFolderChildren("Empty", { "Other/a.md": file("Other/a.md") }), []);
});
