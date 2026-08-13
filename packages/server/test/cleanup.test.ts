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

  it("purges a tombstone once every device's synced cursor has passed its seq", async () => {
    const srv = await startTestServer({
      cleanup: { intervalSecs: 3600, versionsPerFile: 5, keepDeletedFilesSecs: 1 },
    });

    const filePath = "notes/deleted.md";
    const file: FileEntry = {
      path: filePath, sha1: "del-sha", mtime: 1000, action: "active", fileType: "file",
    };
    srv.ctx.db.upsertFile(file);
    srv.ctx.storage.write(filePath, file.mtime, Buffer.from("to be deleted"));

    // Delete it — the tombstone is stamped with a fresh seq.
    srv.ctx.db.upsertFile({ ...file, action: "deleted", mtime: 2000 });
    const tombstoneSeq = srv.ctx.db.getCurrentSeq();

    // A device that has durably synced PAST the deletion.
    srv.ctx.db.touchDevice("device-test");
    srv.ctx.db.recordDeviceSyncedSeq("device-test", tombstoneSeq);

    new SyncCleanup(srv.ctx).run();

    assert.equal(srv.ctx.db.getFile(filePath), undefined);
    assert.equal(srv.ctx.storage.listVersionMtimes(filePath).length, 0);

    await srv.stop();
  });

  it("does NOT purge a deletion a device hasn't synced yet", async () => {
    const srv = await startTestServer({
      cleanup: { intervalSecs: 3600, versionsPerFile: 5, keepDeletedFilesSecs: 1 },
    });

    const filePath = "notes/protected.md";
    srv.ctx.db.upsertFile({
      path: filePath, sha1: "prot-sha", mtime: 1000, action: "active", fileType: "file",
    });
    // A device that has only synced up to BEFORE the deletion.
    const beforeDeleteSeq = srv.ctx.db.getCurrentSeq();
    srv.ctx.db.touchDevice("behind-device");
    srv.ctx.db.recordDeviceSyncedSeq("behind-device", beforeDeleteSeq);

    // Now delete the file — its tombstone seq is above the device's synced cursor.
    srv.ctx.db.upsertFile({
      path: filePath, sha1: "prot-sha", mtime: 2000, action: "deleted", fileType: "file",
    });

    new SyncCleanup(srv.ctx).run();

    // Must still exist — behind-device hasn't seen the deletion.
    assert.ok(srv.ctx.db.getFile(filePath) !== undefined);

    await srv.stop();
  });
});
