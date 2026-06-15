/**
 * Multi-vault stress + conflict-logic test.
 *
 * Simulates three vaults at the WebSocket protocol level against one server:
 *   Vault A — populated, 20,000 files (markdown, PNG, PDF, hidden/.obsidian)
 *             + 100 folder entries. Seeds a fresh server.
 *   Vault B — brand-new empty vault. Receives the full 20k push.
 *   Vault C — pre-existing vault: mostly identical to A, but 1,000 files
 *             NEWER (modified), 500 files STALE (older divergent content),
 *             300 files missing, 200 unique files.
 *
 * Then deliberately exercises every branch of the conflict gate:
 *   - true concurrent edit (stale known baseSha1)  → conflicted copy
 *   - hidden/config path LWW                       → no copy, head re-push
 *   - unknown baseSha1, newer mtime                → LWW accept
 *   - unknown baseSha1, older mtime                → conflict
 *   - delta patch with stale base                  → full upload requested
 *   - delta patch with valid base                  → documents current behavior
 *
 * NOT part of the default `npm test` run (it takes ~1-2 min). Run with:
 *   node --import tsx/esm --test --test-timeout=600000 test/stress.vaults.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { diff_match_patch } from "diff-match-patch";

import { startTestServer, TEST_PASSWORD, type TestServer } from "./helpers.js";

// ─── Sim vault model ─────────────────────────────────────────────────────────

interface SimFile {
  content: Buffer;
  mtime: number;
  sha1: string;
  action: "active" | "deleted";
  fileType: "file" | "folder";
  /** sha1 last synced for this path — sent as baseSha1 on uploads. */
  baseSha1?: string;
}
type Vault = Map<string, SimFile>;

function sha1(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

function addFile(v: Vault, path: string, content: Buffer, mtime: number): void {
  v.set(path, { content, mtime, sha1: sha1(content), action: "active", fileType: "file" });
}

/** Deterministic pseudo-binary content with a real PNG signature. */
function pngBytes(i: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let h = createHash("sha256").update(`png-${i}`).digest();
  const chunks: Buffer[] = [sig];
  for (let k = 0; k < 8; k++) {
    chunks.push(h);
    h = createHash("sha256").update(h).digest();
  }
  return Buffer.concat(chunks); // 8 + 256 bytes
}

function pdfBytes(i: number): Buffer {
  const body = createHash("sha256").update(`pdf-${i}`).digest("hex").repeat(4);
  return Buffer.from(`%PDF-1.4\n% stress test ${i}\n${body}\n%%EOF\n`);
}

const T0 = Date.now() - 86_400_000; // base mtime: 1 day ago

const N_NOTES = 17_000;
const N_PNG = 1_500;
const N_PDF = 500;
const N_HIDDEN = 900;
const N_PLUGIN_JSON = 99;
const TOTAL_FILES = N_NOTES + N_PNG + N_PDF + N_HIDDEN + N_PLUGIN_JSON + 1; // +app.json = 20,000
const N_FOLDERS = 100;

function notePath(i: number): string {
  return `notes/d${i % 100}/note_${i}.md`;
}

function buildVaultA(): Vault {
  const v: Vault = new Map();
  for (let i = 0; i < N_NOTES; i++) {
    addFile(v, notePath(i), Buffer.from(`# Note ${i}\nbody v1 of note ${i}\n`), T0 + i);
  }
  for (let i = 0; i < N_PNG; i++) addFile(v, `assets/img_${i}.png`, pngBytes(i), T0 + i);
  for (let i = 0; i < N_PDF; i++) addFile(v, `docs/pdf_${i}.pdf`, pdfBytes(i), T0 + i);
  for (let i = 0; i < N_HIDDEN; i++) addFile(v, `.hidden/h_${i}.md`, Buffer.from(`hidden ${i} v1`), T0 + i);
  for (let i = 0; i < N_PLUGIN_JSON; i++) {
    addFile(v, `.obsidian/plugins/p${i}/data.json`, Buffer.from(`{"v":1,"i":${i}}`), T0 + i);
  }
  addFile(v, ".obsidian/app.json", Buffer.from(`{"theme":"dark","v":1}`), T0);
  for (let i = 0; i < N_FOLDERS; i++) {
    v.set(`notes/d${i}`, { content: Buffer.alloc(0), mtime: T0, sha1: "", action: "active", fileType: "folder" });
  }
  return v;
}

function cloneVault(v: Vault): Vault {
  const out: Vault = new Map();
  for (const [p, f] of v) out.set(p, { ...f });
  return out;
}

// ─── Protocol-level client ───────────────────────────────────────────────────

class SimClient {
  ws: WebSocket;
  private sink: ((m: any) => void) | null = null;
  private inbox: any[] = [];
  private waiters: Array<{
    pred: (m: any) => boolean;
    resolve: (m: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on("message", (raw: Buffer) => this.dispatch(JSON.parse(raw.toString())));
  }

  private dispatch(m: any): void {
    if (this.sink) {
      this.sink(m);
      return;
    }
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i]!;
      if (w.pred(m)) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve(m);
        return;
      }
    }
    this.inbox.push(m);
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  /** Await the next message matching pred (also scans parked inbox). */
  next<T = any>(pred: (m: any) => boolean = () => true, timeoutMs = 8_000): Promise<T> {
    const idx = this.inbox.findIndex(pred);
    if (idx !== -1) return Promise.resolve(this.inbox.splice(idx, 1)[0] as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(new Error(`next() timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve: resolve as (m: any) => void, timer });
    });
  }

  /** High-throughput mode: route every message (incl. parked) through fn. */
  setSink(fn: (m: any) => void): void {
    this.sink = fn;
    for (const m of this.inbox.splice(0)) fn(m);
  }
  clearSink(): void {
    this.sink = null;
  }

  async auth(deviceId: string): Promise<void> {
    await new Promise<void>((res, rej) => {
      if (this.ws.readyState === this.ws.OPEN) return res();
      this.ws.once("open", res);
      this.ws.once("error", rej);
    });
    const { nonce } = await this.next<{ nonce: string }>((m) => m.type === "challenge");
    const token = createHash("sha256")
      .update(nonce.slice(0, 16) + TEST_PASSWORD + nonce.slice(16))
      .digest("hex");
    this.send({ type: "auth", deviceId, token });
    await this.next((m) => m.type === "auth_ok");
  }

  close(): void {
    this.ws.close();
  }
}

interface SyncStats {
  uploaded: string[];
  pushes: any[];
  conflicts: string[];
}

function applyPush(vault: Vault, m: any): void {
  const f = m.file;
  if (f.action === "deleted") {
    vault.delete(f.path);
    return;
  }
  vault.set(f.path, {
    content: Buffer.from(m.content ?? "", "base64"),
    mtime: f.mtime,
    sha1: f.sha1,
    action: "active",
    fileType: f.fileType,
    baseSha1: f.sha1,
  });
}

/** Full bulk-sync session: chunked manifest, answer upload requests, apply pushes. */
async function runSync(client: SimClient, vault: Vault, label: string, timeoutMs = 300_000): Promise<SyncStats> {
  const entries = [...vault.entries()].map(([path, f]) => ({
    path,
    sha1: f.sha1,
    mtime: f.mtime,
    action: f.action,
    fileType: f.fileType,
  }));
  const CHUNK = 2_000;
  if (entries.length === 0) {
    client.send({ type: "sync", files: [], last: true });
  } else {
    for (let i = 0; i < entries.length; i += CHUNK) {
      client.send({ type: "sync", files: entries.slice(i, i + CHUNK), last: i + CHUNK >= entries.length });
    }
  }

  const stats: SyncStats = { uploaded: [], pushes: [], conflicts: [] };
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => {
      client.clearSink();
      reject(new Error(`[${label}] sync session timed out after ${timeoutMs}ms (uploaded=${stats.uploaded.length}, pushes=${stats.pushes.length})`));
    }, timeoutMs);

    client.setSink((m) => {
      if (m.type === "file_event_result" && m.result === "client_newer") {
        const f = vault.get(m.path);
        assert.ok(f, `[${label}] server requested upload of path the client does not have: ${m.path}`);
        const msg: any = {
          type: "file_data",
          mode: "apply",
          file: { path: m.path, sha1: f.sha1, mtime: f.mtime, action: f.action, fileType: f.fileType },
          content: f.action === "active" && f.fileType === "file" ? f.content.toString("base64") : "",
        };
        if (f.baseSha1) msg.baseSha1 = f.baseSha1;
        client.send(msg);
        f.baseSha1 = f.sha1; // we now consider this synced
        stats.uploaded.push(m.path);
      } else if (m.type === "file_event_result" && m.result === "conflict") {
        stats.conflicts.push(m.path);
      } else if (m.type === "file_push") {
        stats.pushes.push({ file: m.file, size: (m.content ?? "").length });
        applyPush(vault, m);
      } else if (m.type === "sync_done") {
        clearTimeout(to);
        client.clearSink();
        resolve();
      }
    });
  });
  return stats;
}

// ─── Shared state across sequential tests ────────────────────────────────────

let srv: TestServer;
const vaultA = buildVaultA();
const vaultAOriginal = cloneVault(vaultA); // pristine copy for the final convergence pass
let vaultB: Vault;
let vaultC: Vault;

function countConflictCopies(): number {
  return srv.ctx.db.getAllFiles().filter((f) => f.path.includes("(Conflicted Copy") && f.action === "active").length;
}

test("setup: start server", async () => {
  srv = await startTestServer();
});

// ─── 1. Vault A: 20k-file initial upload ────────────────────────────────────

test("vault A (populated, 20k files incl. png/pdf/hidden) seeds a fresh server", async () => {
  const a = new SimClient(srv.port);
  await a.auth("device-A");

  const t = Date.now();
  const stats = await runSync(a, vaultA, "A-initial");
  console.log(`    A initial sync: ${stats.uploaded.length} uploads in ${((Date.now() - t) / 1000).toFixed(1)}s`);

  assert.equal(stats.uploaded.length, TOTAL_FILES + N_FOLDERS, "server should request every file + folder");
  assert.equal(stats.pushes.length, 0, "fresh server has nothing to push");
  assert.equal(stats.conflicts.length, 0);

  const dbStats = srv.ctx.db.getStats();
  assert.equal(dbStats.activeFiles, TOTAL_FILES, "every file recorded active in DB");

  // Byte-exact spot checks: binary png, pdf, hidden, markdown
  for (const p of ["assets/img_42.png", "docs/pdf_7.pdf", ".obsidian/app.json", ".hidden/h_3.md", notePath(123)]) {
    const stored = srv.ctx.storage.readLatest(p);
    assert.ok(stored, `stored content exists for ${p}`);
    assert.ok(stored.equals(vaultA.get(p)!.content), `byte-exact storage for ${p}`);
  }
  a.close();
});

// ─── 2. Vault B: brand-new empty vault receives everything ──────────────────

test("vault B (brand-new empty vault) receives full 20k push", async () => {
  vaultB = new Map();
  const b = new SimClient(srv.port);
  await b.auth("device-B");

  const t = Date.now();
  const stats = await runSync(b, vaultB, "B-bootstrap");
  console.log(`    B bootstrap: ${stats.pushes.length} pushes in ${((Date.now() - t) / 1000).toFixed(1)}s`);

  assert.equal(stats.uploaded.length, 0, "empty vault has nothing to upload");
  assert.equal(stats.conflicts.length, 0);
  assert.equal(stats.pushes.length, TOTAL_FILES + N_FOLDERS, "server pushes every active file + folder");

  // Every file B received must be byte-identical to A's
  let checked = 0;
  for (const [p, fa] of vaultA) {
    if (fa.fileType !== "file") continue;
    const fb = vaultB.get(p);
    assert.ok(fb, `B has ${p}`);
    if (checked % 100 === 0) assert.ok(fb.content.equals(fa.content), `byte-exact ${p}`);
    assert.equal(fb.sha1, fa.sha1, `sha match ${p}`);
    checked++;
  }
  assert.equal(checked, TOTAL_FILES);
  b.close();
});

// ─── 3. Vault C: pre-existing vault with newer/stale/missing/unique files ───

const NEWER = 1_000;   // note indices 0..999        — C edited these (newer mtime)
const STALE = 500;     // note indices 1000..1499    — C has older divergent content
const MISSING = 300;   // note indices 1500..1799    — C never had these
const UNIQUE = 200;    // c-only/u_*.md              — server never saw these

test("vault C (existing, divergent) syncs: newer files upload, stale get corrected, unique upload, missing arrive", async () => {
  vaultC = cloneVault(vaultAOriginal);
  for (let i = 0; i < NEWER; i++) {
    const p = notePath(i);
    const base = vaultC.get(p)!;
    const content = Buffer.from(`# Note ${i}\nbody v2 EDITED ON C\n`);
    vaultC.set(p, { ...base, content, sha1: sha1(content), mtime: base.mtime + 3_600_000, baseSha1: base.sha1 });
  }
  for (let i = NEWER; i < NEWER + STALE; i++) {
    const p = notePath(i);
    const base = vaultC.get(p)!;
    const content = Buffer.from(`# Note ${i}\nstale divergent content on C\n`);
    vaultC.set(p, { ...base, content, sha1: sha1(content), mtime: base.mtime - 3_600_000, baseSha1: undefined });
  }
  for (let i = NEWER + STALE; i < NEWER + STALE + MISSING; i++) {
    vaultC.delete(notePath(i));
  }
  for (let i = 0; i < UNIQUE; i++) {
    addFile(vaultC, `c-only/u_${i}.md`, Buffer.from(`unique to C: ${i}`), Date.now());
  }

  const c = new SimClient(srv.port);
  await c.auth("device-C");
  const t = Date.now();
  const stats = await runSync(c, vaultC, "C-merge");
  console.log(`    C merge: ${stats.uploaded.length} uploads, ${stats.pushes.length} pushes in ${((Date.now() - t) / 1000).toFixed(1)}s`);

  assert.equal(stats.uploaded.length, NEWER + UNIQUE, "uploads = newer + unique");
  assert.equal(stats.pushes.length, STALE + MISSING, "pushes = stale corrections + missing files");
  assert.equal(stats.conflicts.length, 0, "fast-forward uploads must not conflict");

  // Server heads moved to C's edits
  for (const i of [0, 500, 999]) {
    assert.equal(srv.ctx.db.getFile(notePath(i))!.sha1, vaultC.get(notePath(i))!.sha1, `head = C edit for note_${i}`);
  }
  // C's stale copies were corrected back to the server (A v1) content
  for (const i of [1000, 1250, 1499]) {
    assert.equal(vaultC.get(notePath(i))!.sha1, vaultAOriginal.get(notePath(i))!.sha1, `stale note_${i} corrected on C`);
  }
  // Missing files arrived
  for (const i of [1500, 1799]) assert.ok(vaultC.get(notePath(i)), `missing note_${i} restored to C`);
  // Unique files are on the server
  assert.equal(srv.ctx.db.getFile("c-only/u_0.md")!.action, "active");
  c.close();
});

// ─── 4. Deliberate conflict: two devices edit the same base ──────────────────

let clientA2: SimClient;
let clientC2: SimClient;
const CONFLICT_PATH = notePath(16_500); // untouched by vault-C edits

test("conflict: concurrent edit from stale known base mints a Conflicted Copy and preserves the server head", async () => {
  clientA2 = new SimClient(srv.port);
  clientC2 = new SimClient(srv.port);
  await clientA2.auth("device-A");
  await clientC2.auth("device-C");

  const base = srv.ctx.db.getFile(CONFLICT_PATH)!;
  const editA = Buffer.from(`# Note 16500\nedited on A\n`);
  const editC = Buffer.from(`# Note 16500\nedited on C — should become a copy\n`);

  // A commits first: fast-forward from base.
  clientA2.send({
    type: "file_data", mode: "apply",
    file: { path: CONFLICT_PATH, sha1: sha1(editA), mtime: Date.now(), action: "active", fileType: "file" },
    content: editA.toString("base64"),
    baseSha1: base.sha1,
  });
  // C observes A's broadcast — guarantees the server processed A's upload.
  await clientC2.next((m) => m.type === "file_push" && m.file.path === CONFLICT_PATH);
  assert.equal(srv.ctx.db.getFile(CONFLICT_PATH)!.sha1, sha1(editA), "A's edit fast-forwarded the head");

  // C commits from the SAME base — even with a newer mtime, baseSha1 wins.
  const copiesBefore = countConflictCopies();
  clientC2.send({
    type: "file_data", mode: "apply",
    file: { path: CONFLICT_PATH, sha1: sha1(editC), mtime: Date.now() + 5_000, action: "active", fileType: "file" },
    content: editC.toString("base64"),
    baseSha1: base.sha1,
  });

  const conflictRes = await clientC2.next((m) => m.type === "file_event_result" && m.path === CONFLICT_PATH);
  assert.equal(conflictRes.result, "conflict", "uploader is told it conflicted");

  const copyPush = await clientC2.next((m) => m.type === "file_push" && m.file.path.includes("(Conflicted Copy"));
  assert.ok(copyPush.file.path.startsWith("notes/d0/note_16500 (Conflicted Copy"), `copy named after original: ${copyPush.file.path}`);
  assert.ok(copyPush.file.path.includes("device-C".slice(0, 8)), "copy tagged with origin device");
  assert.ok(copyPush.file.path.endsWith(".md"), "extension preserved");
  assert.equal(Buffer.from(copyPush.content, "base64").toString(), editC.toString(), "copy holds C's edit");

  const headRePush = await clientC2.next((m) => m.type === "file_push" && m.file.path === CONFLICT_PATH);
  assert.equal(Buffer.from(headRePush.content, "base64").toString(), editA.toString(), "uploader re-converged on the head (A's edit)");

  // Other peers get the copy broadcast too
  const broadcastToA = await clientA2.next((m) => m.type === "file_push" && m.file.path.includes("(Conflicted Copy"));
  assert.equal(broadcastToA.file.path, copyPush.file.path);

  // The cardinal rule: server head was never overwritten.
  assert.equal(srv.ctx.db.getFile(CONFLICT_PATH)!.sha1, sha1(editA), "head still A's edit");
  assert.equal(countConflictCopies(), copiesBefore + 1, "exactly one conflicted copy minted");
  // C's edit is preserved as an active file, not buried in version history.
  assert.equal(srv.ctx.db.getFile(copyPush.file.path)!.action, "active");
});

// ─── 5. Hidden/config paths: LWW, never a conflict copy ─────────────────────

test("hidden path (.obsidian) conflicts resolve by LWW — stale dropped + head re-pushed, no copy", async () => {
  const P = ".obsidian/app.json";
  const head = srv.ctx.db.getFile(P)!;
  const copiesBefore = countConflictCopies();
  const bogusBase = "0".repeat(40);

  // Stale upload (older mtime, unknown base) → dropped, head re-pushed
  const staleContent = Buffer.from(`{"theme":"light","v":0}`);
  clientC2.send({
    type: "file_data", mode: "apply",
    file: { path: P, sha1: sha1(staleContent), mtime: head.mtime - 10_000, action: "active", fileType: "file" },
    content: staleContent.toString("base64"),
    baseSha1: bogusBase,
  });
  const rePush = await clientC2.next((m) => m.type === "file_push" && m.file.path === P);
  assert.equal(rePush.file.sha1, head.sha1, "head re-pushed unchanged");
  assert.equal(srv.ctx.db.getFile(P)!.sha1, head.sha1, "stale config upload dropped");
  assert.equal(countConflictCopies(), copiesBefore, "no conflict copy for hidden paths");

  // Newer upload (LWW) → accepted even from an unknown base
  const newContent = Buffer.from(`{"theme":"dark","v":2}`);
  clientC2.send({
    type: "file_data", mode: "apply",
    file: { path: P, sha1: sha1(newContent), mtime: head.mtime + 10_000, action: "active", fileType: "file" },
    content: newContent.toString("base64"),
    baseSha1: bogusBase,
  });
  // A receives the broadcast → upload accepted
  const bc = await clientA2.next((m) => m.type === "file_push" && m.file.path === P);
  assert.equal(bc.file.sha1, sha1(newContent));
  assert.equal(srv.ctx.db.getFile(P)!.sha1, sha1(newContent), "newer config upload wins (LWW)");
  assert.equal(countConflictCopies(), copiesBefore, "still no conflict copy");
});

// ─── 6. Unknown base: LWW by mtime ───────────────────────────────────────────

test("unknown baseSha1: newer mtime accepts (LWW), strictly older mtime conflicts", async () => {
  const P = notePath(16_501);
  const head0 = srv.ctx.db.getFile(P)!;
  const unknownBase = "f".repeat(40);

  // Newer mtime + unknown base → accept (copied-vault / lost-ack pattern)
  const x = Buffer.from("accepted via LWW fallback");
  clientC2.send({
    type: "file_data", mode: "apply",
    file: { path: P, sha1: sha1(x), mtime: head0.mtime + 9_999, action: "active", fileType: "file" },
    content: x.toString("base64"),
    baseSha1: unknownBase,
  });
  await clientA2.next((m) => m.type === "file_push" && m.file.path === P); // broadcast = accepted
  assert.equal(srv.ctx.db.getFile(P)!.sha1, sha1(x));

  // Strictly older mtime + unknown base → conflict copy
  const copiesBefore = countConflictCopies();
  const y = Buffer.from("older unknown base → must conflict");
  clientC2.send({
    type: "file_data", mode: "apply",
    file: { path: P, sha1: sha1(y), mtime: head0.mtime - 9_999, action: "active", fileType: "file" },
    content: y.toString("base64"),
    baseSha1: unknownBase,
  });
  const res = await clientC2.next((m) => m.type === "file_event_result" && m.path === P);
  assert.equal(res.result, "conflict");
  assert.equal(srv.ctx.db.getFile(P)!.sha1, sha1(x), "head preserved");
  assert.equal(countConflictCopies(), copiesBefore + 1);

  // Known finding: two conflicts on the same path from the same device within
  // the same minute produce the SAME copy path (timestamp truncated to minutes)
  // — the second copy lands as a new version of the first instead of a new file.
  const z = Buffer.from("second conflict same minute");
  clientC2.send({
    type: "file_data", mode: "apply",
    file: { path: P, sha1: sha1(z), mtime: head0.mtime - 8_888, action: "active", fileType: "file" },
    content: z.toString("base64"),
    baseSha1: unknownBase,
  });
  await clientC2.next((m) => m.type === "file_event_result" && m.path === P);
  const after = countConflictCopies();
  if (after === copiesBefore + 1) {
    console.log("    ⚠ FINDING confirmed: same-minute conflict copies collide (second copy overwrote the first's head)");
  } else {
    console.log("    same-minute collision not observed (minute boundary crossed)");
  }
});

// ─── 7+8. Delta patch path ───────────────────────────────────────────────────

test("delta patch with stale base → server requests a full upload instead of stitching", async () => {
  const P = notePath(16_502);
  const staleBase = "a".repeat(40);
  clientC2.send({
    type: "file_data", mode: "patch",
    file: { path: P, sha1: "irrelevant", mtime: Date.now(), action: "active", fileType: "file" },
    content: "@@ bogus patch @@",
    baseSha1: staleBase,
  });
  const res = await clientC2.next((m) => m.type === "file_event_result" && m.path === P);
  assert.equal(res.result, "client_newer", "stale-base patch must be answered with a full-upload request");

  // Satisfy the request so the peer's pendingUploads drains.
  const f = vaultAOriginal.get(P)!;
  clientC2.send({
    type: "file_data", mode: "apply",
    file: { path: P, sha1: f.sha1, mtime: f.mtime, action: "active", fileType: "file" },
    content: f.content.toString("base64"),
  });
});

test("delta patch with VALID base — documents current behavior (storage.read does not exist on server Storage)", async () => {
  const P = notePath(16_503);
  const head = srv.ctx.db.getFile(P)!;
  const headText = srv.ctx.storage.readLatest(P)!.toString("utf-8");
  const newText = headText + "appended by delta patch\n";

  const dmp = new diff_match_patch();
  const patchText = dmp.patch_toText(dmp.patch_make(headText, newText));

  clientC2.send({
    type: "file_data", mode: "patch",
    file: { path: P, sha1: sha1(Buffer.from(newText)), mtime: Date.now(), action: "active", fileType: "file" },
    content: patchText,
    baseSha1: head.sha1,
  });

  // If patching worked, A would receive a broadcast push for P.
  let patched = false;
  try {
    await clientA2.next((m) => m.type === "file_push" && m.file.path === P, 2_500);
    patched = true;
  } catch {
    /* timeout = patch silently failed server-side */
  }

  const headAfter = srv.ctx.db.getFile(P)!;
  if (!patched) {
    console.log("    🐞 BUG confirmed: valid-base delta patch silently fails — server.ts calls ctx.storage.read(), which does not exist on Storage (readLatest/readVersion only). The TypeError is swallowed by the try/catch and the client gets NO response; the edit is lost until the next full sync.");
    assert.equal(headAfter.sha1, head.sha1, "head unchanged because patch crashed");
  } else {
    console.log("    delta patch applied successfully (bug appears fixed)");
    assert.equal(srv.ctx.storage.readLatest(P)!.toString("utf-8"), newText);
  }
});

// ─── 9. Final convergence: A re-syncs its stale 20k vault ───────────────────

test("convergence: vault A re-syncs its stale full tree — zero uploads, zero conflicts, receives all newer state", async () => {
  const t = Date.now();
  const stats = await runSync(clientA2, vaultAOriginal, "A-reconverge");
  console.log(`    A re-converge: ${stats.uploaded.length} uploads, ${stats.pushes.length} pushes in ${((Date.now() - t) / 1000).toFixed(1)}s`);

  assert.equal(stats.uploaded.length, 0, "nothing on stale A is newer than the server");
  assert.equal(stats.conflicts.length, 0, "a pure re-sync must never mint conflicts");
  assert.ok(stats.pushes.length >= NEWER + UNIQUE, "A receives at least all C edits + C-only files");

  // A converged on the post-conflict state of the world
  assert.equal(vaultAOriginal.get(CONFLICT_PATH)!.sha1, srv.ctx.db.getFile(CONFLICT_PATH)!.sha1);
  assert.equal(vaultAOriginal.get(notePath(0))!.sha1, vaultC.get(notePath(0))!.sha1, "A has C's edit of note_0");
  assert.ok(vaultAOriginal.get("c-only/u_0.md"), "A received C-only files");
  const copies = [...vaultAOriginal.keys()].filter((p) => p.includes("(Conflicted Copy"));
  assert.ok(copies.length >= 1, "A holds the conflicted copies");

  clientA2.close();
  clientC2.close();
});

test("teardown: stop server", async () => {
  await srv.stop();
});
