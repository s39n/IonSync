import express, { type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import type { SyncContext } from "../context.js";
import { sha256 } from "../crypto.js";
import { diff_match_patch } from "diff-match-patch";
import type { BackgroundSyncReq } from "@ionsync/protocol";

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

  // Login
  router.get("/api/login", (req, res) => {
    const password = req.headers["x-dashboard-password"];
    if (password === ctx.config.password) {
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toUTCString();
      res
        .setHeader("Set-Cookie", `dash_token=${DASH_TOKEN}; Path=/; Expires=${expires}; HttpOnly`)
        .status(200)
        .json({ ok: true });
    } else {
      res.status(401).json({ error: "Invalid password" });
    }
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
    const devices = ctx.db.getDevices().map((d) => ({
      ...d,
      connected: connectedIds.has(d.id),
    }));
    res.json(devices);
  });

  // ── Active peers ──────────────────────────────────────────────────────────

  router.get("/api/peers", (req, res) => {
    if (!checkAuth(req, res)) return;
    const peers = Array.from(ctx.peers.values())
      .filter((p) => p.authed)
      .map((p) => ({
        id: p.id,
        deviceId: p.deviceId,
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
    const filesBase = path.resolve(ctx.config.appDir, ctx.config.dataDir, "files");

    const walk = (dir: string): Array<{ path: string; size: number; mtime: string }> => {
      if (!fs.existsSync(dir)) return [];
      const entries: Array<{ path: string; size: number; mtime: string }> = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          entries.push(...walk(full));
        } else {
          const stat = fs.statSync(full);
          entries.push({
            path: full.replace(filesBase + path.sep, "").replace(/\\/g, "/"),
            size: stat.size,
            mtime: stat.mtime.toISOString(),
          });
        }
      }
      return entries;
    };

    res.json(walk(filesBase));
  });

  // ── Read latest version of a file (for dashboard preview) ────────────────
  // Returns { content: base64, encrypted: boolean }.
  // "content" is the raw stored bytes encoded as base64 — if the file was
  // uploaded with E2EE enabled the bytes begin with the IONENCv1 magic and
  // must be decrypted client-side in the browser using the user's passphrase.
  router.get("/api/file-content", (req, res) => {
    if (!checkAuth(req, res)) return;
    const filePath = decodeURIComponent(String(req.query.path ?? "")).trim();
    if (!filePath) { res.status(400).json({ error: "Missing path" }); return; }

    const buf = ctx.storage.readLatest(filePath);
    if (!buf) { res.status(404).json({ error: "File not found" }); return; }

    // Detect E2EE magic ("IONENCv1") so the dashboard can show the lock icon
    // and prompt for the passphrase without having to re-implement detection JS.
    const E2EE_MAGIC = Buffer.from([0x49, 0x4f, 0x4e, 0x45, 0x4e, 0x43, 0x76, 0x31]);
    const encrypted = buf.length >= E2EE_MAGIC.length && buf.slice(0, E2EE_MAGIC.length).equals(E2EE_MAGIC);

    res.json({ content: buf.toString("base64"), encrypted, size: buf.length });
  });

  // ── Delete a file from server storage ─────────────────────────────────────

  router.delete("/api/delete-file/*", (req, res) => {
    if (!checkAuth(req, res)) return;

    const relativePath = decodeURIComponent((req.params as Record<string, string>)["0"] ?? "");
    const filesBase = path.resolve(ctx.config.appDir, ctx.config.dataDir, "files");
    const full = path.resolve(filesBase, relativePath);
    const rel = path.normalize(path.relative(filesBase, full));

    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }

    if (fs.existsSync(full)) {
      fs.unlinkSync(full);
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: "File not found" });
    }
  });

  return router;
}

// ── Fallback dashboard HTML ───────────────────────────────────────────────────
function fallbackDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>IonSync v2</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1rem;color:#222}
h1{font-size:1.4rem}code{background:#f4f4f4;padding:.2em .4em;border-radius:3px}</style>
</head>
<body>
<h1>IonSync Server v2</h1>
<p>Server is running. The dashboard UI hasn't been built yet.</p>
<p>Build the plugin package and copy <code>dashboard.html</code> into <code>client/</code>.</p>
</body>
</html>`;
}