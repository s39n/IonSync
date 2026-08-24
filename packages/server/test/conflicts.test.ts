import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { connectClient, startTestServer, waitForOpen } from "./helpers.js";

const sha1 = (s: string) => createHash("sha1").update(Buffer.from(s)).digest("hex");

describe("conflict management over WebSocket", () => {
  it("lists, reads, restores, and dismisses conflicts", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    // Seed two conflict records, each with stored losing content.
    const idA = srv.ctx.db.recordConflict("notes/a.md", sha1("losing-A"), 1000, "dev-1");
    srv.ctx.storage.write(`_conflicts/${idA}`, 1000, Buffer.from("losing-A"));
    const idB = srv.ctx.db.recordConflict("notes/b.md", sha1("losing-B"), 2000, null);
    srv.ctx.storage.write(`_conflicts/${idB}`, 2000, Buffer.from("losing-B"));

    // conflict_list → both surface
    client.send({ type: "conflict_list" });
    const list = await client.nextMsg<{ conflicts: Array<{ id: number; path: string }> }>(
      (m) => (m as { type: string }).type === "conflict_list_response"
    );
    assert.equal(list.conflicts.length, 2);
    const a = list.conflicts.find((c) => c.path === "notes/a.md");
    assert.equal(a?.id, idA);

    // conflict_content → base64 losing content, not encrypted
    client.send({ type: "conflict_content", id: idA });
    const content = await client.nextMsg<{ content: string; found: boolean; encrypted: boolean }>(
      (m) => (m as { type: string }).type === "conflict_content_response"
    );
    assert.equal(content.found, true);
    assert.equal(content.encrypted, false);
    assert.equal(Buffer.from(content.content, "base64").toString(), "losing-A");

    // conflict_restore → losing content becomes head; conflict resolved
    client.send({ type: "conflict_restore", id: idA });
    const restored = await client.nextMsg<{ action: string; ok: boolean; path?: string }>(
      (m) => (m as { type: string; action?: string }).type === "conflict_action_response" &&
             (m as { action?: string }).action === "restore"
    );
    assert.equal(restored.ok, true);
    assert.equal(restored.path, "notes/a.md");
    assert.equal(srv.ctx.db.getFile("notes/a.md")?.sha1, sha1("losing-A"));
    assert.equal(srv.ctx.storage.readLatest("notes/a.md")?.toString(), "losing-A");

    // conflict_resolve → dismiss B (head untouched)
    client.send({ type: "conflict_resolve", id: idB });
    const dismissed = await client.nextMsg<{ action: string; ok: boolean }>(
      (m) => (m as { type: string; action?: string }).type === "conflict_action_response" &&
             (m as { action?: string }).action === "resolve"
    );
    assert.equal(dismissed.ok, true);

    // Both resolved → list is now empty
    client.send({ type: "conflict_list" });
    const list2 = await client.nextMsg<{ conflicts: unknown[] }>(
      (m) => (m as { type: string }).type === "conflict_list_response"
    );
    assert.equal(list2.conflicts.length, 0);

    // Unknown id → ok:false, no throw
    client.send({ type: "conflict_restore", id: 999999 });
    const unknown = await client.nextMsg<{ ok: boolean; error?: string }>(
      (m) => (m as { type: string }).type === "conflict_action_response"
    );
    assert.equal(unknown.ok, false);

    client.close();
    await srv.stop();
  });
});
