/**
 * Test helpers — spin up a real server on a random port with a temp data dir.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import express from "express";
import { createHash } from "node:crypto";

import { mergeConfig } from "../src/config.js";
import { SyncDB } from "../src/db/index.js";
import { Storage } from "../src/storage/index.js";
import { createContext, type SyncContext } from "../src/context.js";
import { attachWebSocketServer } from "../src/ws/server.js";
import { buildRouter } from "../src/http/routes.js";

export const TEST_PASSWORD = "test-pass-1234";

export interface TestServer {
  ctx: SyncContext;
  port: number;
  stop: () => Promise<void>;
}

export async function startTestServer(
  overrides: Record<string, unknown> = {}
): Promise<TestServer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ionsync-test-"));
  const dbDir = path.join(tmpDir, "db");
  const filesDir = path.join(tmpDir, "files");
  const clientDir = path.join(tmpDir, "client");
  fs.mkdirSync(clientDir, { recursive: true });

  const config = mergeConfig({
    password: TEST_PASSWORD,
    port: 0,
    appDir: tmpDir,
    dataDir: ".",
    ...overrides,
  });

  const db = new SyncDB(dbDir);
  const storage = new Storage(filesDir);
  storage.init();
  const ctx = createContext(config, db, storage, clientDir);

  const app = express();
  app.use(buildRouter(ctx));
  const server = http.createServer(app);
  const wss = attachWebSocketServer(ctx, server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    ctx,
    port,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        // Terminate lingering sockets and close the wss — its 'close' event
        // clears the 30s ping interval that would otherwise keep the event
        // loop alive until the file-level test timeout kills the process.
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// ── WS test client ──────────────────────────────────────────────────────────

export interface TestClient {
  ws: WebSocket;
  nextMsg<T>(predicate?: (msg: unknown) => boolean, timeoutMs?: number): Promise<T>;
  auth(deviceId?: string): Promise<void>;
  send(msg: unknown): void;
  close(): void;
}

export function connectClient(port: number): TestClient {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: unknown[] = [];
  const waiters: Array<{
    predicate: (m: unknown) => boolean;
    resolve: (m: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  ws.on("message", (raw: Buffer) => {
    const msg = JSON.parse(raw.toString());
    // Deliver to the first matching waiter, OR park in the inbox — never both.
    // (Previously a message consumed by a waiter was also pushed to the inbox,
    // so a later nextMsg() with the same predicate would match the stale copy
    // and resolve before the server had processed subsequent messages.)
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i]!;
      if (w.predicate(msg)) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(msg);
        return;
      }
    }
    inbox.push(msg);
  });

  const client: TestClient = {
    ws,

    nextMsg<T>(predicate = () => true, timeoutMs = 5_000): Promise<T> {
      const idx = inbox.findIndex(predicate);
      if (idx !== -1) return Promise.resolve(inbox.splice(idx, 1)[0] as T);
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.timer === timer);
          if (i !== -1) waiters.splice(i, 1);
          reject(new Error(`nextMsg timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push({
          predicate: predicate as (m: unknown) => boolean,
          resolve: resolve as (m: unknown) => void,
          reject,
          timer,
        });
      });
    },

    async auth(deviceId = "device-test") {
      const challenge = await client.nextMsg<{ type: string; nonce: string }>(
        (m) => (m as { type: string }).type === "challenge"
      );
      const { nonce } = challenge;
      const token = createHash("sha256")
        .update(nonce.slice(0, 16) + TEST_PASSWORD + nonce.slice(16))
        .digest("hex");
      client.send({ type: "auth", deviceId, token });
      await client.nextMsg((m) => (m as { type: string }).type === "auth_ok");
    },

    send(msg: unknown) { ws.send(JSON.stringify(msg)); },
    close() { ws.close(); },
  };

  return client;
}

export function waitForOpen(client: TestClient): Promise<void> {
  return new Promise((resolve, reject) => {
    if (client.ws.readyState === client.ws.OPEN) return resolve();
    client.ws.once("open", resolve);
    client.ws.once("error", reject);
  });
}
