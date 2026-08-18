import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { FileEntry } from "@ionsync/protocol";
import { connectClient, startTestServer, waitForOpen, type TestClient, type TestServer } from "./helpers.js";

// Real SHA1s — the upload gate verifies content hashes.
const sha1 = (s: string) => createHash("sha1").update(Buffer.from(s)).digest("hex");
const b64 = (s: string) => Buffer.from(s).toString("base64");

function entry(path: string, content: string, mtime: number): FileEntry {
  return { path, sha1: sha1(content), mtime, action: "active", fileType: "file" };
}

/** file_history round-trip guarantees the previous message was fully processed. */
async function settle(client: TestClient, path: string): Promise<void> {
  client.send({ type: "file_history", path });
  await client.nextMsg((m) => (m as { type: string }).type === "file_history_response");
}

async function uploadNew(client: TestClient, path: string, content: string, mtime: number): Promise<void> {
  client.send({ type: "file_data", mode: "apply", file: entry(path, content, mtime), content: b64(content) });
  await settle(client, path);
}

function hasCopy(srv: TestServer): FileEntry | undefined {
  return srv.ctx.db.getAllFiles().find((f) => f.path.includes("(Conflicted Copy") && f.action === "active");
}

describe("file_rename", () => {
  it("pure move: relinks content + history and tombstones the old path with renamed_to", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    await uploadNew(client, "notes/a.md", "alpha", 1000);
    client.send({ type: "file_rename", from: "notes/a.md", to: "notes/b.md", sha1: sha1("alpha"), mtime: 2000, baseSha1: sha1("alpha"), fileType: "file" });
    await settle(client, "notes/b.md");

    assert.equal(srv.ctx.db.getFile("notes/b.md")?.sha1, sha1("alpha"));
    assert.equal(srv.ctx.db.getFile("notes/b.md")?.action, "active");
    assert.equal(srv.ctx.storage.readLatest("notes/b.md")?.toString(), "alpha");
    assert.equal(srv.ctx.db.getFile("notes/a.md")?.action, "deleted");
    assert.equal(srv.ctx.db.getRenameTarget("notes/a.md"), "notes/b.md");
    assert.ok(!hasCopy(srv));

    client.close();
    await srv.stop();
  });

  it("rename + unsynced edit: relinks then pulls the new content for the target", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    await uploadNew(client, "notes/a.md", "alpha", 1000);
    // sha1 differs from head (an edit preceded the rename) but baseSha1 == head → not a race.
    client.send({ type: "file_rename", from: "notes/a.md", to: "notes/b.md", sha1: sha1("beta"), mtime: 2000, baseSha1: sha1("alpha"), fileType: "file" });

    const pull = await client.nextMsg<{ path: string; result: string }>(
      (m) => (m as { type: string }).type === "file_event_result" && (m as { path: string }).path === "notes/b.md"
    );
    assert.equal(pull.result, "client_newer");

    // Client uploads the new content for the target (new path → no baseSha1).
    client.send({ type: "file_data", mode: "apply", file: entry("notes/b.md", "beta", 2000), content: b64("beta") });
    await settle(client, "notes/b.md");

    assert.equal(srv.ctx.db.getFile("notes/b.md")?.sha1, sha1("beta"));
    assert.equal(srv.ctx.storage.readLatest("notes/b.md")?.toString(), "beta");
    assert.equal(srv.ctx.db.getFile("notes/a.md")?.action, "deleted");
    assert.ok(!hasCopy(srv));

    client.close();
    await srv.stop();
  });

  it("structural conflict (rename lands first, then a stale edit of the old path)", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    await uploadNew(client, "notes/a.md", "alpha", 1000);
    client.send({ type: "file_rename", from: "notes/a.md", to: "notes/b.md", sha1: sha1("alpha"), mtime: 2000, baseSha1: sha1("alpha"), fileType: "file" });
    await settle(client, "notes/b.md");

    // A device that edited notes/a.md concurrently uploads it (based on the pre-rename head).
    client.send({ type: "file_data", mode: "apply", file: entry("notes/a.md", "bravo", 3000), content: b64("bravo"), baseSha1: sha1("alpha") });

    const result = await client.nextMsg<{ path: string; result: string; renamedTo?: string }>(
      (m) => (m as { type: string }).type === "file_event_result" && (m as { path: string }).path === "notes/a.md"
    );
    assert.equal(result.result, "structural_conflict");
    assert.equal(result.renamedTo, "notes/b.md");

    const copyPush = await client.nextMsg<{ file: FileEntry; content: string }>(
      (m) => (m as { type: string }).type === "file_push" && (m as { file: FileEntry }).file.path.includes("(Conflicted Copy")
    );
    assert.equal(copyPush.content, b64("bravo"));

    // Old path stays dead (never resurrected); target keeps A's content; edit preserved as a copy.
    assert.equal(srv.ctx.db.getFile("notes/a.md")?.action, "deleted");
    assert.equal(srv.ctx.db.getFile("notes/b.md")?.sha1, sha1("alpha"));
    assert.equal(hasCopy(srv)?.sha1, sha1("bravo"));

    client.close();
    await srv.stop();
  });

  it("structural conflict (edit lands first, then the rename) converges to the same tree", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    // Head of notes/a.md moves to "bravo" before the rename arrives.
    await uploadNew(client, "notes/a.md", "alpha", 1000);
    client.send({ type: "file_data", mode: "apply", file: entry("notes/a.md", "bravo", 2000), content: b64("bravo"), baseSha1: sha1("alpha") });
    await settle(client, "notes/a.md");

    // Rename based on the stale pre-edit head → structural conflict.
    client.send({ type: "file_rename", from: "notes/a.md", to: "notes/b.md", sha1: sha1("alpha"), mtime: 5000, baseSha1: sha1("alpha"), fileType: "file" });

    const copyPush = await client.nextMsg<{ file: FileEntry; content: string }>(
      (m) => (m as { type: string }).type === "file_push" && (m as { file: FileEntry }).file.path.includes("(Conflicted Copy")
    );
    assert.equal(copyPush.content, b64("bravo")); // the concurrent edit is preserved

    const scResult = await client.nextMsg<{ path: string; result: string; renamedTo?: string }>(
      (m) => (m as { type: string }).type === "file_event_result" &&
             (m as { path: string }).path === "notes/a.md" &&
             (m as { result: string }).result === "structural_conflict"
    );
    assert.equal(scResult.renamedTo, "notes/b.md");

    // The server asks for the initiator's target content; it uploads its renamed version.
    await client.nextMsg(
      (m) => (m as { type: string }).type === "file_event_result" &&
             (m as { path: string }).path === "notes/b.md" &&
             (m as { result: string }).result === "client_newer"
    );
    client.send({ type: "file_data", mode: "apply", file: entry("notes/b.md", "alpha", 5000), content: b64("alpha") });
    await settle(client, "notes/b.md");

    // Same final tree as the rename-first ordering: b.md = alpha, copy = bravo, a.md dead.
    assert.equal(srv.ctx.db.getFile("notes/a.md")?.action, "deleted");
    assert.equal(srv.ctx.db.getFile("notes/b.md")?.sha1, sha1("alpha"));
    assert.equal(hasCopy(srv)?.sha1, sha1("bravo"));

    client.close();
    await srv.stop();
  });

  it("idempotent replay: re-sending the same rename is a no-op", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    await uploadNew(client, "notes/a.md", "alpha", 1000);
    client.send({ type: "file_rename", from: "notes/a.md", to: "notes/b.md", sha1: sha1("alpha"), mtime: 2000, baseSha1: sha1("alpha"), fileType: "file" });
    await settle(client, "notes/b.md");

    // Replay — from is already a rename tombstone whose target has this content.
    client.send({ type: "file_rename", from: "notes/a.md", to: "notes/b.md", sha1: sha1("alpha"), mtime: 2000, baseSha1: sha1("alpha"), fileType: "file" });
    await settle(client, "notes/b.md");

    assert.equal(srv.ctx.db.getFile("notes/b.md")?.sha1, sha1("alpha"));
    assert.equal(srv.ctx.db.getRenameTarget("notes/a.md"), "notes/b.md");
    assert.ok(!hasCopy(srv));

    client.close();
    await srv.stop();
  });

  it("config/dot-path rename never mints a conflicted copy even from a stale base", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    await uploadNew(client, ".obsidian/from.json", "cfg-alpha", 1000);
    client.send({ type: "file_data", mode: "apply", file: entry(".obsidian/from.json", "cfg-beta", 2000), content: b64("cfg-beta"), baseSha1: sha1("cfg-alpha") });
    await settle(client, ".obsidian/from.json");

    // Rename with a stale base — hidden paths use LWW, never a copy.
    client.send({ type: "file_rename", from: ".obsidian/from.json", to: ".obsidian/to.json", sha1: sha1("cfg-alpha"), mtime: 3000, baseSha1: sha1("cfg-alpha"), fileType: "file" });
    // rename+edit path (sha1 != head) pulls the target content.
    await client.nextMsg(
      (m) => (m as { type: string }).type === "file_event_result" && (m as { path: string }).path === ".obsidian/to.json"
    );

    assert.equal(srv.ctx.db.getFile(".obsidian/from.json")?.action, "deleted");
    assert.equal(srv.ctx.db.getFile(".obsidian/to.json")?.action, "active");
    assert.ok(!hasCopy(srv));

    client.close();
    await srv.stop();
  });

  it("folder rename relinks every child path (content + tombstones)", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    await uploadNew(client, "proj/a.md", "aaa", 1000);
    await uploadNew(client, "proj/notes/b.md", "bbb", 1100);

    client.send({ type: "file_rename", from: "proj", to: "work", sha1: "", mtime: 2000, fileType: "folder" });
    await settle(client, "work/a.md");

    assert.equal(srv.ctx.db.getFile("work/a.md")?.action, "active");
    assert.equal(srv.ctx.storage.readLatest("work/a.md")?.toString(), "aaa");
    assert.equal(srv.ctx.db.getFile("work/notes/b.md")?.action, "active");
    assert.equal(srv.ctx.storage.readLatest("work/notes/b.md")?.toString(), "bbb");
    assert.equal(srv.ctx.db.getFile("proj/a.md")?.action, "deleted");
    assert.equal(srv.ctx.db.getFile("proj/notes/b.md")?.action, "deleted");
    assert.ok(!hasCopy(srv));

    client.close();
    await srv.stop();
  });

  it("fresh create on a recycled/renamed name is a new note, not a structural conflict", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    // A note lived at "notes/Untitled 1.md", then was renamed to "notes/Sermon.md".
    await uploadNew(client, "notes/Untitled 1.md", "old sermon", 1000);
    client.send({ type: "file_rename", from: "notes/Untitled 1.md", to: "notes/Sermon.md", sha1: sha1("old sermon"), mtime: 2000, baseSha1: sha1("old sermon"), fileType: "file" });
    await settle(client, "notes/Sermon.md");
    assert.equal(srv.ctx.db.getRenameTarget("notes/Untitled 1.md"), "notes/Sermon.md");

    // Later the user hits "new note" and Obsidian reuses the name "Untitled 1.md".
    // This is a fresh create — NO baseSha1 — so it must be accepted as a new note,
    // never diverted into a "(Conflicted Copy)" of the rename target (which used
    // to close the note out from under the editor).
    await uploadNew(client, "notes/Untitled 1.md", "brand new note", 3000);

    // The new note lives at its own path with its own content.
    assert.equal(srv.ctx.db.getFile("notes/Untitled 1.md")?.action, "active");
    assert.equal(srv.ctx.db.getFile("notes/Untitled 1.md")?.sha1, sha1("brand new note"));
    assert.equal(srv.ctx.storage.readLatest("notes/Untitled 1.md")?.toString(), "brand new note");
    // The rename target is untouched, and no conflict copy was minted.
    assert.equal(srv.ctx.db.getFile("notes/Sermon.md")?.sha1, sha1("old sermon"));
    assert.ok(!hasCopy(srv));
    // The stale rename marker is cleared now that the path is active again.
    assert.equal(srv.ctx.db.getRenameTarget("notes/Untitled 1.md"), null);

    client.close();
    await srv.stop();
  });
});
