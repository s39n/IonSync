import express, { type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import type { SyncContext } from "../context.js";
import { sha256 } from "../crypto.js";
import { diff_match_patch } from "diff-match-patch";
import type { BackgroundSyncReq } from "@ionsync/protocol";
import { verifyTOTP, generateSecret, totpUri, createPendingToken, consumePendingToken,
  generateRecoveryCodes, formatRecoveryCode, normalizeRecoveryCode, hashRecoveryCode } from "../totp.js";
import { pushActivity } from "../context.js";

// ── 1. PUBLIC ROUTER (Exposed to the Tunnel) ────────────────────────────────

export function buildPublicRouter(ctx: SyncContext): express.Router {
  const router = express.Router();

  // ONLY the background sync endpoint goes here. 
  // (The WebSocket engine also attaches to this server automatically)
  router.post("/api/sync/background", express.json({ limit: "50mb" }), async (req: Request, res: Response) => {
    // ... (Keep all your exact background sync logic here) ...
    res.status(200).json({ ok: true });
  });


    return router;
}

// ── 2. ADMIN ROUTER (Locked to Localhost/Trusted Network) ───────────────────

export function buildAdminRouter(ctx: SyncContext): express.Router {
  const router = express.Router();

  const DASH_TOKEN = sha256(ctx.config.password + "-dashboard");

  function grantSession(res: Response, extra: Record<string, unknown> = {}): void {
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toUTCString();
    res
      .setHeader("Set-Cookie", `dash_token=${DASH_TOKEN}; Path=/; Expires=${expires}; HttpOnly`)
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
    if (getDashCookie(req) !== DASH_TOKEN) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    return true;
  }

  // Dashboard HTML
  router.get("/dashboard", (_req, res) => {
    const htmlPath = path.join(ctx.clientDir, "dashboard.html");
    if (fs.existsSync(htmlPath)) {
      res.sendFile(htmlPath);
    } else {
      res.status(200).type("html").send("Dashboard not built yet.");
    }
  });

  // Login — step 1: password
  // If TOTP is enabled, returns { requireTotp: true, tempToken } instead of
  // setting the session cookie immediately. The client then posts the
  // 6-digit code to /api/totp/verify-login to complete authentication.
  router.get("/api/login", (req, res) => {
    const password = req.headers["x-dashboard-password"];
    if (password !== ctx.config.password) {
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
    const { tempToken, code } = req.body as { tempToken?: string; code?: string };
    if (!tempToken || !code) { res.status(400).json({ error: "Missing fields" }); return; }

    if (!consumePendingToken(tempToken)) {
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

    res.status(401).json({ error: "Invalid code" });
  });


  // ── Logs ──────────────────────────────────────────────────────────────────

  router.get("/api/logs", (req, res) => {
    if (!checkAuth(req, res)) return;
    res.type("text/plain").send(ctx.logBuffer.join("\n") || "No logs yet");
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
      target.send({ type: "sync_done" }); 
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: `Unknown action: ${action}` });
    }
  });

  // ── Files list ────────────────────────────────────────────────────────────

  router.get("/api/files", (req, res) => {
    if (!checkAuth(req, res)) return;
    // Source paths from the DB — the old filesystem walk returned storage-layout
    // paths (e.g. "notes/foo.md/v_1234567890") which broke preview and delete.
    const files = ctx.db.getAllFiles()
      .filter(f => f.action === "active" && f.fileType === "file")
      .map(f => ({
        path: f.path,
        size: ctx.storage.getSizeLatest(f.path) ?? 0,
        mtime: f.mtime,
        action: f.action,
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

    // Detect E2EE magic ("IONENCv1") so the dashboard can show the lock icon
    // and prompt for the passphrase without having to re-implement detection JS.
    const E2EE_MAGIC = Buffer.from([0x49, 0x4f, 0x4e, 0x45, 0x4e, 0x43, 0x76, 0x31]);
    const encrypted = buf.length >= E2EE_MAGIC.length && buf.slice(0, E2EE_MAGIC.length).equals(E2EE_MAGIC);

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
    ctx.db.upsertFile({ ...existing, action: "deleted", mtime: Date.now() });
    ctx.storage.deleteAllVersions(filePath);

    res.json({ ok: true });
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
    // Sum storage from disk
    let totalBytes = 0;
    try {
      const allPaths = ctx.db.getAllFilePaths();
      for (const p of allPaths) {
        const size = ctx.storage.getSizeLatest(p);
        if (size) totalBytes += size;
      }
    } catch { /* non-fatal */ }
    res.json({ ...stats, totalBytes });
  });

  // All files with optional action filter: ?action=all|active|deleted
  router.get("/api/db/files", (req, res) => {
    if (!checkAuth(req, res)) return;
    const action = (String(req.query.action ?? "all")) as "active" | "deleted" | "all";
    const files = ctx.db.getFilesByAction(action).map(f => ({
      path: f.path,
      sha1: f.sha1,
      mtime: f.mtime,
      action: f.action,
      size: ctx.storage.getSizeLatest(f.path) ?? 0,
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

    const E2EE_MAGIC = Buffer.from([0x49, 0x4f, 0x4e, 0x45, 0x4e, 0x43, 0x76, 0x31]);
    const snapFiles = ctx.db.getSnapshotFiles(asOfMs);

    const files = snapFiles.map(({ path: filePath, mtime }) => {
      const buf = ctx.storage.readVersion(filePath, mtime);
      if (!buf) return null;
      const encrypted = buf.length >= E2EE_MAGIC.length && buf.slice(0, E2EE_MAGIC.length).equals(E2EE_MAGIC);
      return { path: filePath, mtime, encrypted, content: buf.toString("base64") };
    }).filter((f): f is NonNullable<typeof f> => f !== null);

    res.json({ files, asOf: asOfMs });
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


  // ── TOTP management (authenticated) ─────────────────────────────────────

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
      const allPaths = ctx.db.getAllFilePaths();
      const byFolder: Record<string, number> = {};
      for (const p of allPaths) {
        const folder = p.includes("/") ? p.split("/")[0]! : "(root)";
        const size = ctx.storage.getSizeLatest(p) ?? 0;
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

  // ── Rename a single file (conflict promotion) ─────────────────────────────
  // Body: { from: "conflict/path.md", to: "original/path.md" }
  // Replaces the destination with the source — any existing file at `to` is
  // removed first so the conflict copy becomes the canonical version.
  router.post("/api/rename-file", express.json(), (req, res) => {
    if (!checkAuth(req, res)) return;
    const { from: fromPath, to: toPath } = req.body as { from?: string; to?: string };
    if (!fromPath || !toPath || fromPath === toPath) {
      res.status(400).json({ error: "Provide distinct from and to paths" }); return;
    }
    for (const p of [fromPath, toPath]) {
      const n = path.normalize(p);
      if (n.startsWith("..") || path.isAbsolute(n)) {
        res.status(400).json({ error: "Invalid path" }); return;
      }
    }
    const source = ctx.db.getFile(fromPath);
    if (!source) { res.status(404).json({ error: "Source file not found" }); return; }

    // Remove any existing file at the destination
    const dest = ctx.db.getFile(toPath);
    if (dest) {
      ctx.db.upsertFile({ ...dest, action: "deleted", mtime: Date.now() });
      ctx.storage.deleteAllVersions(toPath);
    }

    // Rename in DB and storage
    ctx.db.renameFilePath(fromPath, toPath);
    ctx.storage.renameFile(fromPath, toPath);

    pushActivity(ctx, { kind: "rename", detail: `${fromPath} => ${toPath}` });
    res.json({ ok: true });
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
