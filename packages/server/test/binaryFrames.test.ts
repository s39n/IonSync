/**
 * Binary-frame wire path (protocol/wire.ts).
 *
 * Verifies that when both peers advertise the "binary_frames" cap, file content
 * crosses the socket as a single binary frame (no base64), and that a peer which
 * does NOT advertise the cap still receives the legacy base64-in-JSON push.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { encodeFrame, decodeFrame, BINARY_FRAMES_CAP } from "@ionsync/protocol";
import { startTestServer, TEST_PASSWORD } from "./helpers.js";

interface BinClient {
  ws: WebSocket;
  nextMsg<T>(predicate?: (m: any) => boolean, timeoutMs?: number): Promise<T>;
  connect(deviceId: string, caps: string[]): Promise<void>;
  sendFrame(frame: string | Uint8Array): void;
  close(): void;
}

/** A raw ws client that decodes both text and binary frames via decodeFrame. */
function binClient(port: number): BinClient {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: any[] = [];
  const waiters: Array<{ predicate: (m: any) => boolean; resolve: (m: any) => void; timer: ReturnType<typeof setTimeout> }> = [];

  ws.on("message", (raw: Buffer, isBinary: boolean) => {
    const data = isBinary ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : raw.toString();
    const msg = decodeFrame(data);
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i]!.predicate(msg)) {
        clearTimeout(waiters[i]!.timer);
        const w = waiters.splice(i, 1)[0]!;
        w.resolve(msg);
        return;
      }
    }
    inbox.push(msg);
  });

  const self: BinClient = {
    ws,
    nextMsg<T>(predicate: (m: any) => boolean = () => true, timeoutMs = 5_000): Promise<T> {
      const idx = inbox.findIndex(predicate);
      if (idx !== -1) return Promise.resolve(inbox.splice(idx, 1)[0] as T);
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("nextMsg timeout")), timeoutMs);
        waiters.push({ predicate, resolve: resolve as (m: any) => void, timer });
      });
    },
    async connect(deviceId: string, caps: string[]) {
      if (ws.readyState !== ws.OPEN) await new Promise<void>((r, e) => { ws.once("open", () => r()); ws.once("error", e); });
      const challenge = await self.nextMsg<{ nonce: string }>((m) => m.type === "challenge");
      const token = createHash("sha256")
        .update(challenge.nonce.slice(0, 16) + TEST_PASSWORD + challenge.nonce.slice(16))
        .digest("hex");
      self.sendFrame(JSON.stringify({ type: "auth", deviceId, token }));
      await self.nextMsg((m) => m.type === "auth_ok");
      self.sendFrame(JSON.stringify({ type: "version_check", version: "2.0.0", build: "0", caps }));
      await self.nextMsg((m) => m.type === "version_check_response");
    },
    sendFrame(frame) { ws.send(frame); },
    close() { ws.close(); },
  };
  return self;
}

const TEXT = "# Binary frame test\nsome unicode: café ☕ 漢字\n";
const BYTES = new TextEncoder().encode(TEXT);
const SHA1 = createHash("sha1").update(BYTES).digest("hex");

function makeFile(path: string) {
  return { path, sha1: SHA1, mtime: Date.now(), action: "active" as const, fileType: "file" as const };
}

describe("binary frames", () => {
  it("exchanges file content as binary frames between two binary-capable peers", async () => {
    const srv = await startTestServer();
    const a = binClient(srv.port);
    const b = binClient(srv.port);
    await a.connect("device-a", [BINARY_FRAMES_CAP]);
    await b.connect("device-b", [BINARY_FRAMES_CAP]);

    // A uploads via a binary frame (contentBytes, no base64).
    const file = makeFile("notes/bin.md");
    a.sendFrame(encodeFrame({ type: "file_data", mode: "apply", file, content: "", contentBytes: BYTES } as any, true));

    // B receives it as a binary file_push carrying raw bytes.
    const push = await b.nextMsg<any>((m) => m.type === "file_push" && m.file?.path === "notes/bin.md");
    assert.ok(push.contentBytes, "push should carry raw contentBytes, not base64");
    assert.equal(Buffer.from(push.contentBytes).toString("utf-8"), TEXT);
    assert.equal(push.file.sha1, SHA1);

    // Server persisted it under the correct sha.
    const stored = srv.ctx.db.getFile("notes/bin.md");
    assert.equal(stored?.sha1, SHA1);

    a.close(); b.close();
    await srv.stop();
  });

  it("falls back to base64-in-JSON for a peer that did not negotiate binary", async () => {
    const srv = await startTestServer();
    const a = binClient(srv.port);
    const legacy = binClient(srv.port);
    await a.connect("device-a", [BINARY_FRAMES_CAP]);
    await legacy.connect("device-legacy", []); // no caps → base64 fallback

    const file = makeFile("notes/legacy.md");
    a.sendFrame(encodeFrame({ type: "file_data", mode: "apply", file, content: "", contentBytes: BYTES } as any, true));

    const push = await legacy.nextMsg<any>((m) => m.type === "file_push" && m.file?.path === "notes/legacy.md");
    // Legacy peer gets base64 in `content`, no raw bytes.
    assert.ok(!push.contentBytes, "legacy peer must not receive raw bytes");
    assert.equal(typeof push.content, "string");
    assert.equal(Buffer.from(push.content, "base64").toString("utf-8"), TEXT);

    a.close(); legacy.close();
    await srv.stop();
  });
});
