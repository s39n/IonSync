/**
 * The REST surface. Plain node:http — a handful of JSON routes do not need a
 * framework, and this process is meant to face the internet through a tunnel.
 */
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiConfig } from "./config.js";
import type { Note, Vault } from "./vault.js";
import { ApiError } from "./errors.js";
import { isHiddenPath, isTextPath, isValidVaultPath } from "./paths.js";
import { parseEditOps } from "./edits.js";
import { searchNotes } from "./search.js";
import { matchesFilter, noteMeta, parseFilter, tagCounts } from "./meta.js";
import { openApiSpec } from "./openapi.js";

type Role = "write" | "read";

const AUTH_FAIL_LIMIT = 10;
const AUTH_FAIL_WINDOW_MS = 5 * 60_000;

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export function createHttpServer(cfg: ApiConfig, vault: Vault): http.Server {
  // Compare fixed-length digests in constant time, so neither the token's
  // content nor its length leaks through response timing.
  const writeDigest = digest(cfg.token);
  const readDigest = cfg.readToken ? digest(cfg.readToken) : null;
  const failures = new Map<string, { count: number; resetAt: number }>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, f] of failures) if (f.resetAt <= now) failures.delete(ip);
  }, 60_000);
  sweep.unref();

  function clientIp(req: http.IncomingMessage): string {
    if (cfg.trustProxy) {
      const cf = req.headers["cf-connecting-ip"];
      if (typeof cf === "string" && cf) return cf;
      const xff = req.headers["x-forwarded-for"];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  /** Base URL callers reach us at — put in the OpenAPI spec so importers need no manual setup. */
  function publicUrl(req: http.IncomingMessage): string {
    if (cfg.publicUrl) return cfg.publicUrl;
    const fwd = req.headers["x-forwarded-proto"];
    const proto = cfg.trustProxy && typeof fwd === "string" && fwd ? fwd.split(",")[0]!.trim() : "http";
    const host = req.headers.host ?? `localhost:${cfg.port}`;
    return `${proto === "https" ? "https" : "http"}://${host}`;
  }

  function authenticate(req: http.IncomingMessage): Role {
    const ip = clientIp(req);
    const now = Date.now();
    const f = failures.get(ip);
    if (f && f.resetAt > now && f.count >= AUTH_FAIL_LIMIT) {
      throw new ApiError(429, "rate_limited", "Too many failed authentication attempts; try again later.");
    }
    const header = req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m) {
      const got = digest(m[1]!.trim());
      const isWrite = timingSafeEqual(got, writeDigest);
      const isRead = readDigest !== null && timingSafeEqual(got, readDigest);
      if (isWrite) return "write";
      if (isRead) return "read";
    }
    if (f && f.resetAt > now) f.count++;
    else failures.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
    throw new ApiError(401, "unauthorized", 'Missing or invalid token. Send "Authorization: Bearer <token>".');
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const p = url.pathname;

    if (method === "GET" && p === "/v1/health") {
      return json(res, 200, { ok: vault.connected && vault.synced, connected: vault.connected, synced: vault.synced });
    }
    if (method === "GET" && p === "/v1/openapi.json") return json(res, 200, openApiSpec(publicUrl(req)));

    const role = authenticate(req);
    const needWrite = (): void => {
      if (role !== "write") throw new ApiError(403, "read_only", "This token is read-only.");
    };
    if (!vault.synced) {
      throw new ApiError(503, "syncing", vault.lastError ?? "The API is still loading the vault; try again in a few seconds.");
    }

    if (method === "GET" && p === "/v1/notes") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const limit = clampInt(url.searchParams.get("limit"), 200, 1, 1000);
      const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
      const byRecent = url.searchParams.get("sort") === "mtime";
      const filter = parseFilter(url.searchParams);
      const all = [...vault.notes.values()].filter((n) => n.path.startsWith(prefix) && (!filter || matchesFilter(n, filter)));
      all.sort(byRecent ? (a, b) => b.mtime - a.mtime : (a, b) => a.path.localeCompare(b.path));
      return json(res, 200, { total: all.length, offset, notes: all.slice(offset, offset + limit).map(summary) });
    }

    if (method === "GET" && p === "/v1/tree") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const depth = clampInt(url.searchParams.get("depth"), 3, 1, 32);
      return json(res, 200, folderTree(vault.notes.values(), prefix, depth));
    }

    if (method === "GET" && p === "/v1/search") {
      const q = url.searchParams.get("q") ?? "";
      const filter = parseFilter(url.searchParams);
      if (!q.trim() && !filter) {
        throw new ApiError(400, "bad_request", 'Give a text query "q", a filter (tag, frontmatter, date, dateFrom, dateTo), or both.');
      }
      const prefix = url.searchParams.get("prefix");
      const results = searchNotes(vault.notes.values(), q, {
        limit: clampInt(url.searchParams.get("limit"), 20, 1, 100),
        filter,
        ...(prefix ? { prefix } : {}),
      });
      return json(res, 200, { query: q, results });
    }

    if (method === "GET" && p === "/v1/tags") {
      return json(res, 200, { tags: tagCounts(vault.notes.values(), url.searchParams.get("prefix") ?? "") });
    }

    if (method === "POST" && p === "/v1/move") {
      needWrite();
      const body = await readJson(req, cfg.maxNoteBytes);
      const from = notePath(body["from"]);
      const to = notePath(body["to"]);
      const r = await vault.move(from, to);
      return json(res, 200, { ...summary(r.note), movedFrom: from, conflict: r.conflict });
    }

    if (p.startsWith("/v1/notes/")) {
      let raw: string;
      try {
        raw = decodeURIComponent(p.slice("/v1/notes/".length));
      } catch {
        throw new ApiError(400, "bad_path", "The note path is not valid URL encoding.");
      }
      const path = notePath(raw);

      if (method === "GET") {
        const note = vault.requireText(path);
        const lines = note.text.split("\n");
        if (url.searchParams.get("meta") === "1") {
          const m = noteMeta(note);
          return json(res, 200, { ...summary(note), totalLines: lines.length, tags: m.tags, date: m.date, dateSource: m.dateSource, frontmatter: m.frontmatter });
        }
        if (url.searchParams.get("outline") === "1") {
          return json(res, 200, { ...summary(note), totalLines: lines.length, outline: outline(lines) });
        }
        // Optional line window, so a long note need not be pulled whole.
        if (url.searchParams.has("from") || url.searchParams.has("lines")) {
          const from = clampInt(url.searchParams.get("from"), 1, 1, Number.MAX_SAFE_INTEGER);
          const count = clampInt(url.searchParams.get("lines"), 200, 1, 100_000);
          const slice = lines.slice(from - 1, from - 1 + count);
          return json(res, 200, { ...summary(note), totalLines: lines.length, from, lines: slice.length, content: slice.join("\n") });
        }
        return json(res, 200, { ...summary(note), totalLines: lines.length, content: note.text });
      }
      if (method === "PUT") {
        needWrite();
        requireWritable(path);
        const body = await readJson(req, cfg.maxNoteBytes);
        const content = body["content"];
        const expected = body["expectedSha1"];
        if (typeof content !== "string") throw new ApiError(400, "bad_request", '"content" must be a string.');
        const r = await vault.write(path, content, {
          ...(typeof expected === "string" ? { expectedSha1: expected } : {}),
          createOnly: body["createOnly"] === true,
        });
        return json(res, r.created ? 201 : 200, { ...summary(r.note), created: r.created, changed: r.changed });
      }
      if (method === "PATCH") {
        needWrite();
        requireWritable(path);
        const body = await readJson(req, cfg.maxNoteBytes);
        const ops = parseEditOps(body["operations"]);
        const expected = body["expectedSha1"];
        const r = await vault.edit(path, ops, typeof expected === "string" ? { expectedSha1: expected } : {});
        return json(res, 200, { ...summary(r.note), changed: r.changed });
      }
      if (method === "DELETE") {
        needWrite();
        const expected = url.searchParams.get("expectedSha1");
        await vault.delete(path, expected ? { expectedSha1: expected } : {});
        return json(res, 200, { path, deleted: true });
      }
      throw new ApiError(405, "method_not_allowed", `${method} is not supported on a note.`);
    }

    throw new ApiError(404, "no_such_route", `No route for ${method} ${p}. See /v1/openapi.json.`);
  }

  return http.createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (err instanceof ApiError) {
        json(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } });
      } else {
        cfg.log(`[api] unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        json(res, 500, { error: { code: "internal", message: "Internal error." } });
      }
    });
  });
}

function summary(n: Note): Record<string, unknown> {
  return { path: n.path, sha1: n.sha1, mtime: n.mtime, size: n.size, kind: n.kind };
}

/** Markdown headings with their line numbers (code fences skipped). */
function outline(lines: string[]): { line: number; level: number; heading: string }[] {
  const out: { line: number; level: number; heading: string }[] = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    if (inFence) return;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (m) out.push({ line: i + 1, level: m[1]!.length, heading: m[2]! });
  });
  return out;
}

/**
 * Folder overview: every folder under `prefix` down to `depth` levels, with how
 * many files sit directly in it and in total beneath it. Lets a model get its
 * bearings in a large vault without listing thousands of paths.
 */
export function folderTree(notes: Iterable<Note>, prefix: string, depth: number): Record<string, unknown> {
  const base = prefix.replace(/\/+$/, "");
  const baseDepth = base === "" ? 0 : base.split("/").length;
  const folders = new Map<string, { files: number; total: number; latestMtime: number }>();
  let total = 0;
  for (const n of notes) {
    if (base !== "" && !n.path.startsWith(base + "/")) continue;
    total++;
    const segs = n.path.split("/");
    segs.pop();
    for (let d = baseDepth; d <= segs.length && d <= baseDepth + depth; d++) {
      const key = segs.slice(0, d).join("/");
      let f = folders.get(key);
      if (!f) folders.set(key, (f = { files: 0, total: 0, latestMtime: 0 }));
      f.total++;
      if (d === segs.length) f.files++;
      if (n.mtime > f.latestMtime) f.latestMtime = n.mtime;
    }
  }
  const list = [...folders.entries()]
    .map(([path, f]) => ({ path: path === "" ? "/" : path + "/", ...f }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { prefix: base === "" ? "" : base + "/", depth, totalFiles: total, folders: list };
}

/** Validate a caller-supplied vault path. */
function notePath(raw: unknown): string {
  if (!isValidVaultPath(raw)) {
    throw new ApiError(400, "bad_path", 'Invalid path. Use a vault-relative path with forward slashes, e.g. "Projects/Plan.md".');
  }
  if (isHiddenPath(raw)) {
    throw new ApiError(403, "hidden_path", "Hidden and configuration paths (any segment starting with a dot) are not available through the API.");
  }
  return raw;
}

function requireWritable(path: string): void {
  if (!isTextPath(path)) {
    throw new ApiError(400, "bad_path", 'The API only writes text notes. Give the path a text extension, e.g. ".md".');
  }
}

function clampInt(raw: string | null, dflt: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

function readJson(req: http.IncomingMessage, maxNoteBytes: number): Promise<Record<string, unknown>> {
  // JSON escaping can inflate content, so allow headroom over the note limit.
  const limit = maxNoteBytes * 2 + 64 * 1024;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (e: ApiError): void => {
      if (done) return;
      done = true;
      req.resume(); // drain, so the error response can still be delivered
      reject(e);
    };
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) return fail(new ApiError(413, "too_large", "Request body is too large."));
      chunks.push(c);
    });
    req.on("error", () => fail(new ApiError(400, "bad_request", "Could not read the request body.")));
    req.on("end", () => {
      if (done) return;
      done = true;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new ApiError(400, "bad_request", "The request body must be a JSON object."));
      }
    });
  });
}
