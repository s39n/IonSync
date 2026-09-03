/**
 * CSRF defence-in-depth on admin mutations (SECURITY.md #6).
 *
 * SameSite=Strict is the primary defence; on top of it, every state-changing
 * request must carry an X-CSRF-Token header matching the token bound to its
 * session. Safe methods (GET/HEAD/OPTIONS) are exempt, and mutations must not
 * live on GET — the peer-action route was moved from GET to POST for exactly
 * this reason.
 *
 * The middleware runs before the route handler, so we probe it with
 * POST /api/action/disconnect/<bogus peer>: a passing CSRF check reaches the
 * handler and returns 404 (peer not found); a failing one returns 403.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, TEST_PASSWORD } from "./helpers.js";

async function login(port: number): Promise<{ cookie: string; csrf: string }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/login`, {
    headers: { "x-dashboard-password": TEST_PASSWORD },
  });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  const body = (await r.json()) as { csrf?: string };
  assert.ok(body.csrf, "login returns a CSRF token");
  return { cookie, csrf: body.csrf };
}

const ACTION = "/api/action/disconnect/no-such-peer";

test("mutating request without a CSRF token is rejected (403)", async () => {
  const ts = await startTestServer();
  try {
    const { cookie } = await login(ts.port);
    const r = await fetch(`http://127.0.0.1:${ts.port}${ACTION}`, {
      method: "POST",
      headers: { Cookie: cookie }, // valid session, but no X-CSRF-Token
    });
    assert.equal(r.status, 403, "missing CSRF token must be forbidden");
  } finally {
    await ts.stop();
  }
});

test("mutating request with a wrong CSRF token is rejected (403)", async () => {
  const ts = await startTestServer();
  try {
    const { cookie } = await login(ts.port);
    const r = await fetch(`http://127.0.0.1:${ts.port}${ACTION}`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": "not-the-real-token" },
    });
    assert.equal(r.status, 403, "wrong CSRF token must be forbidden");
  } finally {
    await ts.stop();
  }
});

test("mutating request with the matching CSRF token passes the guard", async () => {
  const ts = await startTestServer();
  try {
    const { cookie, csrf } = await login(ts.port);
    const r = await fetch(`http://127.0.0.1:${ts.port}${ACTION}`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": csrf },
    });
    // Reached the handler (peer doesn't exist) — proves CSRF passed, not 403.
    assert.notEqual(r.status, 403, "a matching token must not be forbidden");
    assert.equal(r.status, 404, "handler ran and reported the unknown peer");
  } finally {
    await ts.stop();
  }
});

test("the peer-action route is POST-only — GET no longer mutates", async () => {
  const ts = await startTestServer();
  try {
    const { cookie } = await login(ts.port);
    const r = await fetch(`http://127.0.0.1:${ts.port}${ACTION}`, {
      headers: { Cookie: cookie }, // GET — no such route now
    });
    assert.equal(r.status, 404, "there is no GET handler for the action route");
  } finally {
    await ts.stop();
  }
});

test("/api/csrf returns the session token, and rejects an unauthenticated caller", async () => {
  const ts = await startTestServer();
  try {
    const { cookie, csrf } = await login(ts.port);
    const ok = await fetch(`http://127.0.0.1:${ts.port}/api/csrf`, { headers: { Cookie: cookie } });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { csrf?: string };
    assert.equal(body.csrf, csrf, "/api/csrf returns the same session-bound token");

    const denied = await fetch(`http://127.0.0.1:${ts.port}/api/csrf`);
    assert.equal(denied.status, 401, "no session → unauthorized");
  } finally {
    await ts.stop();
  }
});
