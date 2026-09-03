/**
 * Admin session cookie hardening (SECURITY.md #3).
 *
 * The dashboard session cookie must be marked `Secure` when the request came in
 * over HTTPS — either the admin server terminated TLS itself (adminTls) or a
 * trusted reverse proxy did and forwarded X-Forwarded-Proto (trustProxy). Over
 * plain HTTP it must NOT be Secure, or the browser would silently drop it and
 * lock the user out of a plain-HTTP LAN dashboard.
 *
 * (Native adminTls sets req.secure directly; here we drive the equivalent path
 * through a trusted proxy header, which is simpler to exercise in-process.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, TEST_PASSWORD } from "./helpers.js";

async function loginRaw(port: number, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/api/login`, {
    headers: { "x-dashboard-password": TEST_PASSWORD, ...headers },
  });
}

test("cookie has no Secure over plain HTTP (default, no proxy trust)", async () => {
  const ts = await startTestServer(); // trustProxy defaults to false
  try {
    const r = await loginRaw(ts.port, { "X-Forwarded-Proto": "https" }); // spoofed, must be ignored
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie") ?? "";
    assert.match(cookie, /dash_token=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /Secure/,
      "an untrusted X-Forwarded-Proto must not flip the cookie to Secure");
  } finally {
    await ts.stop();
  }
});

test("cookie is Secure when a trusted proxy reports HTTPS", async () => {
  const ts = await startTestServer({ trustProxy: true });
  try {
    const r = await loginRaw(ts.port, { "X-Forwarded-Proto": "https" });
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie") ?? "";
    assert.match(cookie, /dash_token=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/, "HTTPS via a trusted proxy must mark the cookie Secure");
  } finally {
    await ts.stop();
  }
});

test("cookie is not Secure when a trusted proxy reports plain HTTP", async () => {
  const ts = await startTestServer({ trustProxy: true });
  try {
    const r = await loginRaw(ts.port, { "X-Forwarded-Proto": "http" });
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie") ?? "";
    assert.doesNotMatch(cookie, /Secure/, "plain HTTP through the proxy stays non-Secure");
  } finally {
    await ts.stop();
  }
});
