import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeOfflineDeletes, cascadeDeleteExceedsSafetyCap } from "@ionsync/protocol";
import type { FileEntry } from "@ionsync/protocol";

// Minimal metadata entry helper (only the fields computeOfflineDeletes reads).
function meta(action: FileEntry["action"], fileType: FileEntry["fileType"] = "file"): Partial<FileEntry> {
  return { action, fileType, sha1: "deadbeef" };
}

describe("computeOfflineDeletes (sync-audit gap S4)", () => {
  it("flags an active file that is in metadata but gone from disk", () => {
    const metadata = { "notes/a.md": meta("active"), "notes/b.md": meta("active") };
    const onDisk = new Set(["notes/a.md"]); // b.md was deleted while offline
    assert.deepEqual(computeOfflineDeletes(metadata as any, onDisk), ["notes/b.md"]);
  });

  it("never flags a file that is still on disk", () => {
    const metadata = { "notes/a.md": meta("active") };
    const onDisk = new Set(["notes/a.md"]);
    assert.deepEqual(computeOfflineDeletes(metadata as any, onDisk), []);
  });

  it("ignores entries already tombstoned in metadata", () => {
    const metadata = { "notes/a.md": meta("active"), "notes/gone.md": meta("deleted") };
    const onDisk = new Set(["notes/a.md"]); // gone.md absent, but already deleted → not re-sent
    assert.deepEqual(computeOfflineDeletes(metadata as any, onDisk), []);
  });

  it("ignores folder entries (only files are reconciled)", () => {
    const metadata = { "proj": meta("active", "folder"), "proj/a.md": meta("active") };
    const onDisk = new Set<string>(["some/other.md"]); // both proj paths absent
    assert.deepEqual(computeOfflineDeletes(metadata as any, onDisk), ["proj/a.md"]);
  });

  it("respects the exclusion filter (config / .obsidian paths)", () => {
    const metadata = { ".obsidian/app.json": meta("active"), "notes/a.md": meta("active") };
    const onDisk = new Set(["notes/a.md"]); // both config + note absent... note present
    const isExcluded = (p: string) => p.startsWith(".obsidian/");
    // .obsidian/app.json is absent from disk but excluded → not flagged; note is on disk.
    assert.deepEqual(computeOfflineDeletes(metadata as any, onDisk, isExcluded), []);
  });

  it("returns [] for an empty disk snapshot — never mass-deletes on a missing scan", () => {
    const metadata = { "notes/a.md": meta("active"), "notes/b.md": meta("active") };
    assert.deepEqual(computeOfflineDeletes(metadata as any, new Set()), []);
  });

  it("skips undefined metadata values defensively", () => {
    const metadata = { "notes/a.md": undefined, "notes/b.md": meta("active") };
    const onDisk = new Set(["notes/c.md"]); // non-empty snapshot, neither a nor b present
    assert.deepEqual(computeOfflineDeletes(metadata as any, onDisk), ["notes/b.md"]);
  });
});

describe("offline-delete safety-cap composition", () => {
  it("a normal handful of offline deletes is under the cap", () => {
    const total = 500;
    const missing = 5;
    assert.equal(cascadeDeleteExceedsSafetyCap(missing, total), false);
  });

  it("refuses when an implausible fraction of the vault looks deleted (unmounted)", () => {
    const total = 500;
    const missing = 400; // > 33% of the vault
    assert.equal(cascadeDeleteExceedsSafetyCap(missing, total), true);
  });

  it("refuses above the absolute hard cap regardless of vault size", () => {
    assert.equal(cascadeDeleteExceedsSafetyCap(1001, 1_000_000), true);
  });
});
