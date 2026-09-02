import express, { type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual, randomBytes } from "node:crypto";
import archiver from "archiver";
import { ConnectionRateLimiter } from "../ws/rateLimit.js";
import type { SyncContext } from "../context.js";
import type { FileEntry } from "@ionsync/protocol";
import { sha256 } from "../crypto.js";
import { isE2eeEncrypted, makeE2eeDecryptor } from "../e2ee.js";
import { broadcastToPeers } from "../ws/handlers/sync.js";
import { verifyTOTP, generateSecret, totpUri, createPendingToken, consumePendingToken,
  generateRecoveryCodes, formatRecoveryCode, normalizeRecoveryCode, hashRecoveryCode } from "../totp.js";
import { pushActivity } from "../context.js";

// E2EE helpers live in ../e2ee.js (shared, version-aware). The dashboard
// export/preview routes use makeE2eeDecryptor(password), which derives one key
// per format version and caches it, so a bulk export pays PBKDF2 once per
// version rather than once per file.

// ── 1. PUBLIC ROUTER (Exposed to the Tunnel) ────────────────────────────────

export function buildPublicRouter(ctx: SyncContext): express.Router {
  const router = express.Router();
  // Nothing is exposed over plain HTTP on the public port — all sync traffic
  // goes through the authenticated WebSocket attached to the same server.
  // (A previous /api/sync/background stub accepted unauthenticated 50 MB JSON
  // bodies and silently discarded them; it has been removed. See XSync's
  // visibility-change handler, which now flushes pending events over the WS.)
  void ctx;
  return router;
}

/**
 * Constant-time string comparison for secrets (dashboard password / session
 * token). A plain `!==` short-circuits at the first differing character and
 * leaks match length via response timing.
 */
function secretsMatch(received: string, expected: string): boolean {
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── 2. ADMIN ROUTER (Locked to Localhost/Trusted Network) ───────────────────

export function buildAdminRouter(ctx: SyncContext): express.Router {
  const router = express.Router();

  // Baseline hardening headers on every admin response.
  router.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  // Content-Security-Policy for the dashboard page — defence in depth on top
  // of the output escaping in dashboard.html. Scripts run only with the
  // per-request nonce (injected into the <script> tags when the page is
  // served) or from cdnjs (qrcodejs/JSZip, which are inserted dynamically and
  // therefore matched by host). No 'unsafe-inline' for scripts: the dashboard
  // uses delegated listeners instead of inline on* handlers, so injected
  // markup can never execute. Styles keep 'unsafe-inline' (inline style
  // attributes are cosmetic and not a script-execution vector).
  const dashboardCsp = (nonce: string): string => [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  // Random, server-issued admin sessions. Replaces the old deterministic
  // dash_token = sha256(password + "-dashboard"), which any password-holder
  // could compute offline (SECURITY.md #1) and use to skip TOTP entirely (#2).
  // A session now exists only after a completed /api/login (+ TOTP when
  // enabled). Tokens are 256-bit random; we keep only their SHA-256 + an
  // expiry, so the in-memory store never holds a usable token. Sessions live in
  // memory: a server restart (e.g. a deploy) invalidates them and the admin
  // logs in again — an intentional trade-off that also makes them revocable.
  const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const sessions = new Map<string, number>(); // sha256(token) -> expiresAt (ms)

  function issueSessionToken(): string {
    const now = Date.now();
    for (const [h, exp] of sessions) if (exp <= now) sessions.delete(h); // sweep expired
    const token = randomBytes(32).toString("base64url");
    sessions.set(sha256(token), now + SESSION_TTL_MS);
    return token;
  }

  function sessionValid(token: string): boolean {
    if (!token) return false;
    const h = sha256(token);
    const exp = sessions.get(h);
    if (exp === undefined) return false;
    if (exp <= Date.now()) { sessions.delete(h); return false; }
    return true;
  }

  // Per-IP throttle for the login endpoints. The WS side has had this from the
  // start; without it the HTTP login was an unthrottled brute-force oracle.
  const loginLimiter = new ConnectionRateLimiter({
    windowMs: 60_000,
    maxConnections: 30,   // login attempts per IP per minute
    maxAuthFailures: 10,  // wrong passwords / TOTP codes before a block
    blockMs: 5 * 60_000,
  });

  function loginAllowed(req: Request, res: Response): boolean {
    const ip = req.socket.remoteAddress ?? "unknown";
    if (!loginLimiter.allowConnection(ip)) {
      res.status(429).json({ error: "Too many attempts — try again later" });
      return false;
    }
    return true;
  }

  function recordLoginFailure(req: Request): void {
    loginLimiter.recordAuthFailure(req.socket.remoteAddress ?? "unknown");
  }

  function grantSession(res: Response, extra: Record<string, unknown> = {}): void {
    const token = issueSessionToken();
    const expires = new Date(Date.now() + SESSION_TTL_MS).toUTCString();
    // SameSite=Strict: the cookie authorises destructive admin actions (factory
    // reset, delete, purge); without it any web page the admin visits could
    // fire cross-site requests at these endpoints (CSRF).
    res
      .setHeader("Set-Cookie", `dash_token=${token}; Path=/; Expires=${expires}; HttpOnly; SameSite=Strict`)
      .status(200)
      .json({ ok: true, ...extra });
  }

  function getDashCookie(req: Request): string | undefined {
    const cookieHeader = req.headers["cookie"] ?? "";
    for (const part of cookieHeader.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k?.trim() === "dash_token") return decodeURIComponent(v.join("="));
    }
    return undefined;
  }

  function checkAuth(req: Request, res: Response): boolean {
    if (!sessionValid(getDashCookie(req) ?? "")) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    return true;
  }

  // Dashboard HTML — served with a fresh script nonce stamped into every
  // <script> tag so the CSP can drop 'unsafe-inline' for scripts entirely.
  router.get("/dashboard", (_req, res) => {
    const nonce = randomBytes(16).toString("base64");
    res.setHeader("Content-Security-Policy", dashboardCsp(nonce));
    const htmlPath = path.join(ctx.clientDir, "dashboard.html");
    if (fs.existsSync(htmlPath)) {
      const html = fs
        .readFileSync(htmlPath, "utf8")
        .replace(/<script\b/g, `<script nonce="${nonce}"`);
      res.type("html").send(html);
    } else {
      res.status(200).type("html").send("Dashboard not built yet.");
    }
  });

  // Login — step 1: password
  // If TOTP is enabled, returns { requireTotp: true, tempToken } instead of
  // setting the session cookie immediately. The client then posts the
  // 6-digit code to /api/totp/verify-login to complete authentication.
  router.get("/api/login", (req, res) => {
    if (!loginAllowed(req, res)) return;
    const password = req.headers["x-dashboard-password"];
    if (typeof password !== "string" || !secretsMatch(password, ctx.config.password)) {
      recordLoginFailure(req);
      res.status(401).json({ error: "Invalid password" });
      return;
    }
    const totpSecret = ctx.db.getSetting("totp_secret");
    if (totpSecret) {
      // TOTP is configured — issue a short-lived bridge token
      const tempToken = createPendingToken();
      res.status(200).json({ requireTotp: true, tempToken });
    } else {
      // No TOTP — grant session immediately
      grantSession(res);
    }
  });

  // Login — step 2: TOTP code OR recovery code
  router.post("/api/totp/verify-login", express.json(), (req, res) => {
    if (!loginAllowed(req, res)) return;
    const { tempToken, code } = req.body as { tempToken?: string; code?: string };
    if (!tempToken || !code) { res.status(400).json({ error: "Missing fields" }); return; }

    if (!consumePendingToken(tempToken)) {
      recordLoginFailure(req);
      res.status(401).json({ error: "Token expired or invalid" });
      return;
    }

    const totpSecret = ctx.db.getSetting("totp_secret");
    if (!totpSecret) { res.status(401).json({ error: "2FA not configured" }); return; }

    // Try TOTP first
    if (verifyTOTP(totpSecret, code.replace(/\s/g, ""))) {
      grantSession(res);
      return;
    }

    // Try recovery code
    const normalized = normalizeRecoveryCode(code);
    const codesJson = ctx.db.getSetting("totp_recovery_codes");
    if (codesJson) {
      const hashes: string[] = JSON.parse(codesJson);
      const inputHash = hashRecoveryCode(normalized);
      const idx = hashes.indexOf(inputHash);
      if (idx !== -1) {
        // Consume the code — it can only be used once
        const remaining = hashes.filter((_, i) => i !== idx);
        ctx.db.setSetting("totp_recovery_codes", JSON.stringify(remaining));
        grantSession(res, { usedRecoveryCode: true, codesRemaining: remaining.length });
        return;
      }
    }

    recordLoginFailure(req);
    res.status(401).json({ error: "Invalid code" });
  });


  // ── Logs ──────────────────────────────────────────────────────────────────

  router.get("/api/logs", (req, res) => {
    if (!checkAuth(req, res)) return;
    res.type("text/plain").send(ctx.logBuffer.join("\n") || "No logs yet");
  });

  // ── Live event stream (Server-Sent Events) ───────────────────────────────
  // The dashboard opens this once and refreshes the moment the server signals a
  // change, instead of polling on a fixed timer. Auth is the same dash_token
  // cookie (EventSource sends cookies on same-origin). The CSP already permits
  // connect-src 'self', so no page-level change is needed.
  router.get("/api/events", (req, res) => {
    if (!checkAuth(req, res)) return;
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Disable proxy buffering (nginx) so events are delivered immediately.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    // retry: reconnect backoff hint; ": connected" is a comment that opens the
    // stream so the browser fires `onopen` right away.
    res.write("retry: 3000\n\n: connected\n\n");

    ctx.sse.clients.add(res);
    // Heartbeat comment keeps intermediaries from closing an idle connection.
    const heartbeat = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { /* cleaned up on close */ }
    }, 25_000);
    (heartbeat as { unref?: () => void }).unref?.();
    req.on("close", () => {
      clearInterval(heartbeat);
      ctx.sse.clients.delete(res);
    });
  });

  // ── Devices ───────────────────────────────────────────────────────────────

  router.get("/api/devices", (req, res) => {
    if (!checkAuth(req, res)) return;
    const connectedIds = new Set(
      Array.from(ctx.peers.values())
        .filter((p) => p.authed && p.deviceId)
        .map((p) => p.deviceId!)
    );
    const names = ctx.db.getAllDeviceNames();
    const devices = ctx.db.getDevices().map((d) => ({
      ...d,
      connected: connectedIds.has(d.id),
      name: names[d.id] ?? null,
    }));
    res.json(devices);
  });

  // Set or clear a friendly name for a device
  router.patch("/api/device-name", express.json(), (req, res) => {
    if (!checkAuth(req, res)) return;
    const { id, name } = req.body as { id?: string; name?: string };
    if (!id || typeof id !== "string") { res.status(400).json({ error: "Missing id" }); return; }
    if (name && name.trim()) {
      ctx.db.setDeviceName(id, name.trim());
    } else {
      ctx.db.deleteDeviceName(id);
    }
    res.json({ ok: true });
  });

  // ── Active peers ──────────────────────────────────────────────────────────

  router.get("/api/peers", (req, res) => {
    if (!checkAuth(req, res)) return;
    const peers = Array.from(ctx.peers.values())
      .filter((p) => p.authed)
      .map((p) => ({
        id: p.id,
        deviceId: p.deviceId,
        deviceName: p.deviceId ? ctx.db.getDeviceName(p.deviceId) : null,
        autoSync: p.autoSync,
        pendingUploads: p.pendingUploads.size,
      }));
    res.json(peers);
  });

  // ── Peer actions ──────────────────────────────────────────────────────────

  router.get("/api/action/:action/:peerId", (req, res) => {
    if (!checkAuth(req, res)) return;
    const { action, peerId } = req.params as { action: string; peerId: string };
    const target = ctx.peers.get(peerId);

    if (!target) {
      res.status(404).json({ error: "Peer not found" });
      return;
    }

    if (action === "disconnect") {
      target.disconnect("Disconnected by admin");
      res.json({ ok: true });
    } else if (action === "trigger-sync") {
      // Ask the client to actually run a sync cycle (cursor catch-up), rather
      // than sending a bare sync_done — which the client just treats as "no
      // pending transfers" bookkeeping and does not reconcile anything from.
      // Without this, admin-side changes (e.g. a dashboard delete) never
      // reached an already-connected client until it reconnected.
      target.send({ type: "request_sync" });
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: `Unknown action: ${action}` });
    }
  });

  // ── Files list ────────────────────────────────────────────────────────────

  router.get("/api/files", (req, res) => {
    if (!checkAuth(req, res)) return;
    // Sizes come from the DB column stamped at upload time (migration v5) —
    // the previous per-file storage stat was O(files) directory scans on every
    // 5-second dashboard poll, which crawled on 20k–50k file vaults. Rows
    // predating v5 (size = -1) fall back to a one-off stat and heal on the
    // next upload.
    // Resolve an attribution device id to its friendly name (set in the Devices
    // panel), falling back to a short id, or null when unknown (pre-v7 rows).
    const who = (id: string | null): string | null =>
      id ? (ctx.db.getDeviceName(id) ?? id.slice(0, 8)) : null;
    const files = ctx.db.getFilesWithSize("active")
      .map(f => ({
        path: f.path,
        size: f.size >= 0 ? f.size : (ctx.storage.getSizeLatest(f.path) ?? 0),
        mtime: f.mtime,
        action: f.action,
        createdBy: who(f.createdBy),
        lastBy: who(f.lastBy),
      }));
    res.json(files);
  });

  // ── List all stored versions of a file ───────────────────────────────────
  // Returns { versions: Array<{ sha1, mtime, receivedAt, size }> } newest-first.
  router.get("/api/file-versions", (req, res) => {
    if (!checkAuth(req, res)) return;
    const filePath = decodeURIComponent(String(req.query.path ?? "")).trim();
    if (!filePath) { res.status(400).json({ error: "Missing path" }); return; }

    const versions = ctx.db.getVersions(filePath).map(v => ({
      ...v,
      size: ctx.storage.getSizeVersion(filePath, v.mtime) ?? 0,
    }));
    res.json({ versions });
  });

  // ── Read a specific (or latest) version of a file ────────────────────────
  // Returns { content: base64, encrypted: boolean, mtime: number }.
  // Pass ?mtime=<epoch-ms> to fetch a specific version; omit for latest.
  // "content" is the raw stored bytes encoded as base64 — if the file was
  // uploaded with E2EE enabled the bytes begin with the IONENCv1 magic and
  // must be decrypted client-side in the browser using the user's passphrase.
  router.get("/api/file-content", (req, res) => {
    if (!checkAuth(req, res)) return;
    const filePath = decodeURIComponent(String(req.query.path ?? "")).trim();
    if (!filePath) { res.status(400).json({ error: "Missing path" }); return; }

    const mtimeParam = String(req.query.mtime ?? "").trim();
    let buf: Buffer | null;
    let resolvedMtime: number | undefined;

    if (mtimeParam) {
      const mtime = parseInt(mtimeParam, 10);
      if (isNaN(mtime)) { res.status(400).json({ error: "Invalid mtime" }); return; }
      buf = ctx.storage.readVersion(filePath, mtime);
      resolvedMtime = mtime;
    } else {
      buf = ctx.storage.readLatest(filePath);
      const versions = ctx.db.getVersions(filePath);
      resolvedMtime = versions[0]?.mtime;
    }

    if (!buf) { res.status(404).json({ error: "File not found" }); return; }

    // Detect E2EE magic ("IONENCv<N>") so the dashboard can show the lock icon
    // and prompt for the passphrase without having to re-implement detection JS.
    const encrypted = isE2eeEncrypted(buf);

    res.json({ content: buf.toString("base64"), encrypted, size: buf.length, mtime: resolvedMtime });
  });

  // ── Delete a file from server storage ─────────────────────────────────────

  router.delete("/api/delete-file/*", (req, res) => {
    if (!checkAuth(req, res)) return;

    const filePath = decodeURIComponent((req.params as Record<string, string>)["0"] ?? "").trim();
    if (!filePath) { res.status(400).json({ error: "Invalid path" }); return; }

    // Reject path traversal
    const normalized = path.normalize(filePath);
    if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }

    const existing = ctx.db.getFile(filePath);
    if (!existing) { res.status(404).json({ error: "File not found" }); return; }

    // Mark deleted in DB and remove all stored version files from disk
    const deletedEntry = { ...existing, action: "deleted" as const, mtime: Date.now() };
    ctx.db.upsertFile(deletedEntry);
    ctx.storage.deleteAllVersions(filePath);

    // Push the deletion to already-connected peers immediately. Without this,
    // a client that stays connected never sees the delete until it happens to
    // reconnect — clicking the dashboard's "Sync" button used to be a no-op
    // (see trigger-sync above), so the file would appear to "come back" on
    // every dashboard sync attempt. sourcePeer is null: this delete has no
    // originating WS connection to exclude from the broadcast.
    broadcastToPeers(ctx, null, deletedEntry);
    pushActivity(ctx, { kind: "delete", path: filePath });

    res.json({ ok: true });
  });

  // ── Bulk delete every active file under a folder prefix ──────────────────
  // Motivation: deleting a folder in Obsidian does not reliably propagate a
  // delete for each nested file, so folders can end up stranded (still active)
  // on the server and re-pushed to every device. This lets an operator clear a
  // whole subtree in one action. Each matched file goes through the SAME path
  // as the single-file delete above (mark deleted, drop versions, broadcast),
  // so connected peers converge immediately.

  /** Normalise a folder prefix and reject traversal. Returns null on invalid. */
  function normalizePrefix(raw: string): string | null {
    const trimmed = raw.trim().replace(/\/+$/, ""); // strip trailing slashes
    if (!trimmed) return null;
    const normalized = path.normalize(trimmed);
    if (normalized.startsWith("..") || path.isAbsolute(normalized)) return null;
    return trimmed;
  }

  /** Active files whose path is exactly the prefix or sits under "<prefix>/". */
  function activeFilesUnder(prefix: string): FileEntry[] {
    const dir = prefix + "/";
    return ctx.db
      .getFilesByAction("active")
      .filter((f) => f.path === prefix || f.path.startsWith(dir));
  }

  // Preview: how many files (and total bytes) a folder delete would affect.
  router.get("/api/folder-file-count", (req, res) => {
    if (!checkAuth(req, res)) return;
    const prefix = normalizePrefix(String(req.query.prefix ?? ""));
    if (prefix === null) { res.status(400).json({ error: "Invalid prefix" }); return; }
    const matches = activeFilesUnder(prefix);
    const bytes = matches.reduce((sum, f) => sum + (ctx.storage.getSizeLatest(f.path) ?? 0), 0);
    res.json({ prefix, count: matches.length, bytes });
  });

  router.post("/api/delete-folder", express.json(), (req, res) => {
    if (!checkAuth(req, res)) return;
    const prefix = normalizePrefix(String((req.body as { prefix?: unknown })?.prefix ?? ""));
    if (prefix === null) { res.status(400).json({ error: "Invalid prefix" }); return; }

    const matches = activeFilesUnder(prefix);
    for (const file of matches) {
      const deletedEntry = { ...file, action: "deleted" as const, mtime: Date.now() };
      ctx.db.upsertFile(deletedEntry);
      ctx.storage.deleteAllVersions(file.path);
      broadcastToPeers(ctx, null, deletedEntry);
    }
    if (matches.length > 0) {
      pushActivity(ctx, { kind: "delete", detail: `${prefix}/ (${matches.length} files)` });
    }
    res.json({ ok: true, prefix, deleted: matches.length });
  });

  // ── Update file metadata (mtime only, no new version row) ────────────────

  router.patch("/api/file-metadata", express.json(), (req, res) => {
    if (!checkAuth(req, res)) return;
    const { path: filePath, mtime } = req.body as { path?: string; mtime?: unknown };
    if (!filePath || typeof filePath !== "string" || filePath.trim() === "") {
      res.status(400).json({ error: "Missing or invalid path" }); return;
    }
    if (!Number.isInteger(mtime) || (mtime as number) <= 0) {
      res.status(400).json({ error: "mtime must be a positive integer (epoch ms)" }); return;
    }
    // Reject path traversal
    const normalized = path.normalize(filePath.trim());
    if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
      res.status(400).json({ error: "Invalid path" }); return;
    }
    const existing = ctx.db.getFile(filePath.trim());
    if (!existing) { res.status(404).json({ error: "File not found" }); return; }
    ctx.db.updateFileMeta(filePath.trim(), mtime as number);
    res.json({ ok: true });
  });

  // ── Database manager ──────────────────────────────────────────────────────

  // Aggregate stats
  router.get("/api/db/stats", (req, res) => {
    if (!checkAuth(req, res)) return;
    const stats = ctx.db.getStats();
    // Known sizes are a single SUM in SQLite; only pre-v5 rows are statted.
    let totalBytes = 0;
    try {
      const { knownBytes, unknownPaths } = ctx.db.getActiveSizeSummary();
      totalBytes = knownBytes;
      for (const p of unknownPaths) {
        totalBytes += ctx.storage.getSizeLatest(p) ?? 0;
      }
    } catch { /* non-fatal */ }
    res.json({ ...stats, totalBytes });
  });

  // All files with optional action filter: ?action=all|active|deleted
  router.get("/api/db/files", (req, res) => {
    if (!checkAuth(req, res)) return;
    const action = (String(req.query.action ?? "all")) as "active" | "deleted" | "all";
    const files = ctx.db.getFilesWithSize(action).map(f => ({
      path: f.path,
      sha1: f.sha1,
      mtime: f.mtime,
      action: f.action,
      size: f.size >= 0 ? f.size : (ctx.storage.getSizeLatest(f.path) ?? 0),
    }));
    res.json(files);
  });

  // Restore a single deleted file
  router.post("/api/db/restore-file", express.json(), (req, res) => {
    if (!checkAuth(req, res)) return;
    const { path: filePath } = req.body as { path?: string };
    if (!filePath) { res.status(400).json({ error: "Missing path" }); return; }
    const ok = ctx.db.restoreFile(filePath);
    res.json({ ok });
  });

  // Delete a specific file version from storage + DB
  router.delete("/api/db/version", (req, res) => {
    if (!checkAuth(req, res)) return;
    const filePath = decodeURIComponent(String(req.query.path ?? "")).trim();
    const mtime = parseInt(String(req.query.mtime ?? ""), 10);
    if (!filePath || isNaN(mtime)) { res.status(400).json({ error: "Missing path or mtime" }); return; }
    ctx.storage.deleteVersion(filePath, mtime);
    ctx.db.deleteVersionRecord(filePath, mtime);
    res.json({ ok: true });
  });

  // Remove a device record
  router.delete("/api/db/device/:id", (req, res) => {
    if (!checkAuth(req, res)) return;
    const { id } = req.params as { id: string };
    // Disconnect the peer if currently connected
    for (const peer of ctx.peers.values()) {
      if (peer.deviceId === id) peer.disconnect("Device removed by admin");
    }
    ctx.db.deleteDevice(id);
    ctx.db.deleteDeviceName(id);
    res.json({ ok: true });
  });

  // ── Restore deleted files ─────────────────────────────────────────────────

  router.post("/api/restore-deleted", (req, res) => {
    if (!checkAuth(req, res)) return;
    const count = ctx.db.restoreDeletedFiles();
    res.json({ ok: true, restored: count });
  });

  // ── Purge deleted file records ────────────────────────────────────────────
  // Physically removes rows with action="deleted" from the DB so the server
  // forgets the file entirely and treats a re-upload as brand new.
  //
  // DELETE /api/db/purge-deleted          → purge ALL deleted records
  // DELETE /api/db/purge-deleted?path=... → purge a single path
  router.delete("/api/db/purge-deleted", (req, res) => {
    if (!checkAuth(req, res)) return;
    const rawPath = String(req.query.path ?? "").trim();
    if (rawPath) {
      const normalized = path.normalize(rawPath);
      if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
        res.status(400).json({ error: "Invalid path" }); return;
      }
      const count = ctx.db.purgeDeletedFiles(rawPath);
      res.json({ ok: true, purged: count });
    } else {
      const count = ctx.db.purgeDeletedFiles();
      res.json({ ok: true, purged: count });
    }
  });

  // ── Prune corrupt (0-byte) version files ─────────────────────────────────
  // Walks the entire storage tree, removes any v_* file whose size is 0, and
  // deletes the matching file_versions row from the DB.
  // Returns { removed: number, entries: [{filePath, mtime}] }
  router.post("/api/db/prune-corrupt-versions", (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
      const entries = ctx.storage.pruneCorruptVersions();
      for (const { filePath, mtime } of entries) {
        // Remove the corrupt version record from the DB.
        ctx.db.deleteVersionRecord(filePath, mtime);

        // If the files table is pointing at the corrupt version, repoint it
        // to the latest good version so clients receive correct content on
        // the next sync.  If no good versions remain, leave the record as-is
        // (the file will serve empty content until the client re-uploads).
        const currentFile = ctx.db.getFile(filePath);
        if (currentFile && currentFile.mtime === mtime) {
          const remaining = ctx.db.getVersions(filePath); // newest first, corrupt already removed
          if (remaining.length > 0) {
            // Bump mtime to now so the server is definitively newer than any
            // client that already downloaded the corrupt version.  Without this
            // the client's corrupt mtime would win the comparison and it would
            // re-upload the 0-byte file, undoing the prune.
            ctx.db.repointFileRecord(filePath, remaining[0]!.sha1, Date.now());
          }
        }
      }
      res.json({ ok: true, removed: entries.length, entries });
    } catch (e: unknown) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Factory reset ─────────────────────────────────────────────────────────

  router.post("/api/reset", (req, res) => {
    if (!checkAuth(req, res)) return;

    // Disconnect all connected peers so they re-sync cleanly from scratch
    for (const peer of ctx.peers.values()) {
      peer.disconnect("Server reset");
    }

    // Wipe DB (files, file_versions, devices)
    ctx.db.resetAll();

    // Wipe all stored file content from disk
    ctx.storage.deleteAllFiles();

    res.json({ ok: true });
  });

  // ── Snapshot export ────────────────────────────────────────────────────────
  // Returns JSON: { files: Array<{ path, mtime, encrypted, content: base64 }> }
  // The browser builds the final ZIP (via JSZip) and decrypts E2EE entries
  // client-side — the server never sees the passphrase.
  router.get("/api/export-snapshot", (req, res) => {
    if (!checkAuth(req, res)) return;

    const dateParam = String(req.query.date ?? "").trim();
    if (!dateParam) { res.status(400).json({ error: "Missing date parameter" }); return; }

    const asOfMs = new Date(dateParam).getTime();
    if (isNaN(asOfMs)) { res.status(400).json({ error: "Invalid date" }); return; }

    // Optional E2EE password — if provided, encrypted files are decrypted on
    // the fly before being added to the ZIP so the export is plaintext.
    const e2eePw = String(req.headers["x-e2ee-password"] ?? "").trim();
    const decryptE2ee = e2eePw ? makeE2eeDecryptor(e2eePw) : null;
    if (decryptE2ee) console.log("[export] E2EE password supplied — files will be decrypted in ZIP");

    const snapFiles = ctx.db.getSnapshotFiles(asOfMs);
    const dateLabel = new Date(asOfMs).toISOString().slice(0, 10);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="ionsync-snapshot-${dateLabel}.zip"`);

    const archive = archiver("zip", { zlib: { level: 6 } });

    archive.on("error", (err) => {
      console.error("[export] archiver error:", err);
    });

    archive.on("finish", () => {
      console.log(`[export] ZIP complete — ${archive.pointer()} bytes (${snapFiles.length} entries considered)`);
    });

    // Stop reading files if the client disconnects mid-download.
    res.on("close", () => {
      if (!res.writableFinished) {
        try { archive.abort(); } catch { /* already finalized */ }
      }
    });

    archive.pipe(res);

    // Stream ONE entry at a time: the next file is appended when archiver
    // fires "entry" for the previous one. The old loop appended every file's
    // Buffer up front, so a 50k-file export held the whole vault's content in
    // archiver's internal queue. Plain files are appended as lazy read
    // streams; only E2EE files that must be decrypted are buffered (AES-GCM
    // needs the full blob), and never more than one at a time.
    let idx = 0;
    const appendNext = (): void => {
      while (idx < snapFiles.length) {
        const { path: filePath, mtime } = snapFiles[idx++]!;
        try {
          const prefix = ctx.storage.readVersionPrefix(filePath, mtime, 8);
          if (!prefix) continue; // no stored version — skip

          if (decryptE2ee && isE2eeEncrypted(prefix)) {
            const buf = ctx.storage.readVersion(filePath, mtime);
            if (!buf) continue;
            let finalBuf = buf;
            try {
              finalBuf = decryptE2ee(buf);
            } catch {
              console.warn(`[export] decryption failed for "${filePath}" — wrong key? Including encrypted.`);
            }
            archive.append(finalBuf, { name: filePath, date: new Date(mtime) });
          } else {
            const stream = ctx.storage.openVersionStream(filePath, mtime);
            if (!stream) continue;
            archive.append(stream, { name: filePath, date: new Date(mtime) });
          }
          return; // wait for "entry" before appending the next file
        } catch (e) {
          console.warn(`[export] skipping "${filePath}": ${e}`);
        }
      }
      void archive.finalize();
    };
    archive.on("entry", appendNext);
    appendNext();
  });

  // Export a ZIP of specific files (latest version of each).
  // POST /api/export-selected   body: { paths: string[] }
  // Optional header X-E2EE-Password for on-the-fly decryption.
  router.post("/api/export-selected", express.json(), (req, res) => {
    if (!checkAuth(req, res)) return;

    const paths: unknown = req.body?.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      res.status(400).json({ error: "No paths provided" });
      return;
    }

    const e2eePw = String(req.headers["x-e2ee-password"] ?? "").trim();
    const decryptE2ee = e2eePw ? makeE2eeDecryptor(e2eePw) : null;

    const timestamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="ionsync-export-${timestamp}.zip"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => console.error("[export-selected] archiver error:", err));
    res.on("close", () => {
      if (!res.writableFinished) {
        try { archive.abort(); } catch { /* already finalized */ }
      }
    });
    archive.pipe(res);

    // One entry in flight at a time — see export-snapshot above for rationale.
    const pathList = (paths as unknown[]).map(String);
    let idx = 0;
    const appendNext = (): void => {
      while (idx < pathList.length) {
        const filePath = pathList[idx++]!;
        try {
          const mtime = ctx.storage.latestVersionMtime(filePath);
          if (mtime === null) continue; // no stored version — skip

          const prefix = ctx.storage.readVersionPrefix(filePath, mtime, 8);
          if (prefix && decryptE2ee && isE2eeEncrypted(prefix)) {
            const buf = ctx.storage.readVersion(filePath, mtime);
            if (!buf) continue;
            let finalBuf = buf;
            try { finalBuf = decryptE2ee(buf); } catch { /* wrong key — include encrypted */ }
            archive.append(finalBuf, { name: filePath });
          } else {
            const stream = ctx.storage.openVersionStream(filePath, mtime);
            if (!stream) continue;
            archive.append(stream, { name: filePath });
          }
          return;
        } catch (e) {
          console.warn(`[export-selected] skipping "${filePath}": ${e}`);
        }
      }
      void archive.finalize();
    };
    archive.on("entry", appendNext);
    appendNext();
  });

  // ── TOTP management ──────────────────────────────────────────────────────

  // Status — is TOTP configured?
  router.get("/api/totp/status", (req, res) => {
    if (!checkAuth(req, res)) return;
    const enabled = ctx.db.getSetting("totp_secret") !== null;
    res.json({ enabled });
  });

  // Generate a fresh TOTP secret + URI for the setup QR code.
  // Does NOT save the secret — the client must call /api/totp/enable once
  // the user has verified the code works in their authenticator app.
  router.post("/api/totp/generate", (req, res) => {
    if (!checkAuth(req, res)) return;
    const secret = generateSecret();
    const uri = totpUri(secret, "IonSync", "dashboard");
    res.json({ secret, uri });
  });

  // Enable TOTP — verify code, save secret, generate recovery codes.
  // Recovery codes are returned ONCE and never stored in plaintext.
  router.post("/api/totp/enable", express.json(), (req, res) => {
    if (!checkAuth(req, res)) return;
    const { secret, code } = req.body as { secret?: string; code?: string };
    if (!secret || !code) { res.status(400).json({ error: "Missing fields" }); return; }
    if (!verifyTOTP(secret, code)) {
      res.status(401).json({ error: "Code does not match — check your authenticator app" });
      return;
    }
    const rawCodes = generateRecoveryCodes();
    const hashes = rawCodes.map(hashRecoveryCode);
    ctx.db.setSetting("totp_secret", secret);
    ctx.db.setSetting("totp_recovery_codes", JSON.stringify(hashes));
    res.json({ ok: true, recoveryCodes: rawCodes.map(formatRecoveryCode) });
  });

  // Disable TOTP — requires the current TOTP code as confirmation.
  router.post("/api/totp/disable", express.json(), (req, res) => {
    if (!checkAuth(req, res)) return;
    const totpSecret = ctx.db.getSetting("totp_secret");
    if (!totpSecret) { res.json({ ok: true }); return; } // already disabled
    const { code } = req.body as { code?: string };
    if (!code) { res.status(400).json({ error: "Missing code" }); return; }
    if (!verifyTOTP(totpSecret, code)) {
      res.status(401).json({ error: "Invalid code" });
      return;
    }
    ctx.db.deleteSetting("totp_secret");
    ctx.db.deleteSetting("totp_recovery_codes");
    res.json({ ok: true });
  });

  // ── Storage breakdown by folder ──────────────────────────────────────────
  // Returns [ { folder: string, bytes: number }, … ] sorted largest-first.
  router.get("/api/db/storage-by-folder", (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
      const files = ctx.db.getFilesWithSize("active");
      const byFolder: Record<string, number> = {};
      for (const f of files) {
        const folder = f.path.includes("/") ? f.path.split("/")[0]! : "(root)";
        const size = f.size >= 0 ? f.size : (ctx.storage.getSizeLatest(f.path) ?? 0);
        byFolder[folder] = (byFolder[folder] ?? 0) + size;
      }
      const rows = Object.entries(byFolder)
        .map(([folder, bytes]) => ({ folder, bytes }))
        .sort((a, b) => b.bytes - a.bytes);
      res.json(rows);
    } catch (e: unknown) {
      res.status(500).json({ error: String(e) });
    }
  });


  // ── Rename folder ─────────────────────────────────────────────────────────
  // Body: { from: "old/path", to: "new/path" }
  router.post("/api/rename-folder", express.json(), (req, res) => {
    if (!checkAuth(req, res)) return;
    const { from: fromPrefix, to: toPrefix } = req.body as { from?: string; to?: string };
    if (!fromPrefix || !toPrefix || fromPrefix === toPrefix) {
      res.status(400).json({ error: "Provide distinct from and to folder prefixes" }); return;
    }
    // Basic path-traversal guard
    for (const p of [fromPrefix, toPrefix]) {
      const n = path.normalize(p);
      if (n.startsWith("..") || path.isAbsolute(n)) {
        res.status(400).json({ error: "Invalid path" }); return;
      }
    }
    try {
      const moved = ctx.storage.renameFolder(fromPrefix, toPrefix);
      const count  = ctx.db.renameFolderPaths(fromPrefix, toPrefix);
      // Disconnect all peers so they re-sync with the new paths
      for (const peer of ctx.peers.values()) {
        peer.disconnect("Folder renamed — please reconnect to re-sync");
      }
      pushActivity(ctx, { kind: "rename", detail: `${fromPrefix} => ${toPrefix} (${count} files)` });
      res.json({ ok: true, files: count, storageEntries: moved.length });
    } catch (e: unknown) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Activity feed ─────────────────────────────────────────────────────────
  // Returns the last 100 structured activity events, newest-first.
  // ── Conflicts (reviewable records, in place of copy files) ────────────
  router.get("/api/conflicts", (req, res) => {
    if (!checkAuth(req, res)) return;
    const includeResolved = String(req.query.all ?? "") === "1";
    const list = ctx.db.listConflicts(includeResolved).map(c => ({
      ...c,
      deviceName: c.deviceId ? (ctx.db.getDeviceName(c.deviceId) ?? c.deviceId.slice(0, 8)) : null,
    }));
    res.json(list);
  });

  // Losing content of one conflict (base64; decrypt client-side for E2EE).
  router.get("/api/conflict-content", (req, res) => {
    if (!checkAuth(req, res)) return;
    const id = Number(req.query.id);
    const c = Number.isFinite(id) ? ctx.db.getConflict(id) : undefined;
    if (!c) { res.status(404).json({ error: "Unknown conflict" }); return; }
    const buf = ctx.storage.readLatest(`_conflicts/${c.id}`);
    res.json({ id: c.id, path: c.path, mtime: c.mtime, content: buf ? buf.toString("base64") : "", encrypted: buf ? isE2eeEncrypted(buf) : false });
  });

  // Dismiss a conflict (mark resolved). Head is unaffected.
  router.post("/api/conflict-resolve", express.json(), (req, res) => {
    if (!checkAuth(req, res)) return;
    const id = Number((req.body ?? {}).id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Missing id" }); return; }
    ctx.db.resolveConflict(id);
    res.json({ ok: true });
  });

  // Restore a conflict's losing content as the file's CURRENT head and sync it
  // to every device (broadcast). Marks the conflict resolved.
  router.post("/api/conflict-restore", express.json(), (req, res) => {
    if (!checkAuth(req, res)) return;
    const id = Number((req.body ?? {}).id);
    const c = Number.isFinite(id) ? ctx.db.getConflict(id) : undefined;
    if (!c) { res.status(404).json({ error: "Unknown conflict" }); return; }
    const buf = ctx.storage.readLatest(`_conflicts/${c.id}`);
    if (!buf) { res.status(404).json({ error: "Conflict content missing" }); return; }
    const entry: FileEntry = { path: c.path, sha1: c.sha1, mtime: Date.now(), action: "active", fileType: "file" };
    ctx.storage.write(c.path, entry.mtime, buf);
    ctx.db.upsertFile(entry, buf.length, null);
    ctx.db.resolveConflict(id);
    broadcastToPeers(ctx, null, entry);
    pushActivity(ctx, { kind: "upload", path: c.path });
    res.json({ ok: true });
  });

  router.get("/api/activity", (req, res) => {
    if (!checkAuth(req, res)) return;
    res.json([...ctx.activityLog].reverse());
  });


  return router;
}

// ── Fallback dashboard HTML ────────────────────────

// ── Combined router (used by tests and the main server) ─────────────────────

/**
 * Returns a single router that mounts both the public and admin sub-routers.
 * Tests use this; the production server may mount them separately for
 * network-level isolation (public vs. localhost-only), but a combined mount
 * works fine in any single-network environment.
 */
export function buildRouter(ctx: SyncContext): express.Router {
  const router = express.Router();
  router.use(buildPublicRouter(ctx));
  router.use(buildAdminRouter(ctx));
  return router;
}
