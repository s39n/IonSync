import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FileEntry } from "@ionsync/protocol";
import { startTestServer } from "./helpers.js";
import { SyncCleanup } from "../src/cleanup/index.js";

describe("SyncCleanup", () => {
  it("prunes old file versions down to versionsPerFile", async () => {
    const srv = await startTestServer({
      cleanup: { intervalSecs: 3600, versionsPerFile: 2, keepDeletedFilesSecs: 86400 },
    });

    const filePath = "notes/pruned.md";

    for (let i = 1; i <= 4; i++) {
      const file: FileEntry = {
        path: filePath, sha1: `sha-${i}`, mtime: i * 1000, action: "active", fileType: "file",
      };
      srv.ctx.db.upsertFile(file);
      srv.ctx.storage.write(filePath, file.mtime, Buffer.from(`version ${i}`));
    }

    assert.equal(srv.ctx.storage.listVersionMtimes(filePath).length, 4);

    new SyncCleanup(srv.ctx).run();

    const remaining = srv.ctx.storage.listVersionMtimes(filePath);
    assert.equal(remaining.length, 2);
    assert.equal(remaining[0], 4000);
    assert.equal(remaining[1], 3000);

    const dbVersions = srv.ctx.db.getVersions(filePath);
    assert.equal(dbVersions.length, 2);

    await srv.stop();
  });

  it("purges deleted files after all devices have been online past the cutoff", async () => {
    const srv = await startTestServer({
      cleanup: { intervalSecs: 3600, versionsPerFile: 5, keepDeletedFilesSecs: 1 },
    });

    const filePath = "notes/deleted.md";
    const file: FileEntry = {
      path: filePath, sha1: "del-sha", mtime: 1000, action: "active", fileType: "file",
    };
    srv.ctx.db.upsertFile(file);
    srv.ctx.storage.write(filePath, file.mtime, Buffer.from("to be deleted"));

    // Mark deleted (received_at is set to now by upsertFile)
    srv.ctx.db.upsertFile({ ...file, action: "deleted", mtime: 2000 });

    // Wait past the 1s keep window, then touch the device so oldestDeviceOnline > cutoff
    await new Promise((r) => setTimeout(r, 1100));
    srv.ctx.db.touchDevice("device-test");

    new SyncCleanup(srv.ctx).run();

    assert.equal(srv.ctx.db.getFile(filePath), undefined);
    assert.equal(srv.ctx.storage.listVersionMtimes(filePath).length, 0);

    await srv.stop();
  });

  it("does NOT purge deleted files if a device hasn't been online since deletion", async () => {
    const srv = await startTestServer({
      cleanup: { intervalSecs: 3600, versionsPerFile: 5, keepDeletedFilesSecs: 1 },
    });

    // Register a device that came online before we create/delete the file
    srv.ctx.db.touchDevice("offline-device");

    const filePath = "notes/protected.md";
    const file: FileEntry = {
      path: filePath, sha1: "prot-sha", mtime: 1000, action: "deleted", fileType: "file",
    };
    srv.ctx.db.upsertFile(file);

    // Wait past the keep window — but do NOT touch offline-device again
    await new Promise((r) => setTimeout(r, 1100));

    new SyncCleanup(srv.ctx).run();

    // Record must still exist because offline-device predates the deletion
    const stored = srv.ctx.db.getFile(filePath);
    assert.ok(stored !== undefined);

    await srv.stop();
  });
});
