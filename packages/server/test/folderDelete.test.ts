import { test } from "node:test";
import assert from "node:assert/strict";
import { collectFolderChildren, cascadeDeleteExceedsSafetyCap, CASCADE_HARD_CAP } from "@ionsync/protocol";
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

test("cascade safety cap blocks implausibly large folder deletes but allows normal ones", () => {
  // Normal folder deletes pass through.
  assert.equal(cascadeDeleteExceedsSafetyCap(10, 20000), false);
  assert.equal(cascadeDeleteExceedsSafetyCap(300, 20000), false);
  // Over the absolute hard cap is blocked.
  assert.equal(cascadeDeleteExceedsSafetyCap(CASCADE_HARD_CAP + 1, 1_000_000), true);
  // Over a third of the whole vault is blocked even under the hard cap.
  assert.equal(cascadeDeleteExceedsSafetyCap(40, 100), true);
  assert.equal(cascadeDeleteExceedsSafetyCap(33, 100), false); // exactly a third: allowed
  // The production incident (~14k deletes in a ~22k vault) would be blocked.
  assert.equal(cascadeDeleteExceedsSafetyCap(14000, 22000), true);
  // No vault size known yet (fresh): only the hard cap applies.
  assert.equal(cascadeDeleteExceedsSafetyCap(200, 0), false);
});
