/**
 * Setup links ("Add a device").
 *
 * - plugin/src/pairing.ts parses an UNTRUSTED obsidian://ionsync-setup link, so
 *   its validation is tested here (the plugin package has no test runner; the
 *   module is pure and imports nothing from Obsidian).
 * - GET /api/pairing gives the dashboard its defaults and must be auth-gated
 *   and must never hand back the sync password.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, TEST_PASSWORD } from "./helpers.js";
import { mergeConfig } from "../src/config.js";
import {
  buildPairingUri,
  pairingAddress,
  parsePairingParams,
  PAIRING_ACTION,
} from "../../plugin/src/pairing.js";

/** What Obsidian hands a protocol handler: the decoded query parameters. */
function paramsOf(uri: string): Record<string, string> {
  const url = new URL(uri);
  return Object.fromEntries(url.searchParams.entries());
}

test("pairing: a built link round-trips through the parser", () => {
  const req = { host: "sync.example.com", port: 443, tls: true, password: "p&ss word=#1+é" };
  const uri = buildPairingUri(req);
  assert.ok(uri.startsWith(`obsidian://${PAIRING_ACTION}?`));
  const parsed = parsePairingParams(paramsOf(uri));
  assert.deepEqual(parsed, { ok: true, request: req });
});

test("pairing: port and password are optional; tls defaults to off", () => {
  const parsed = parsePairingParams({ host: "192.168.1.50" });
  assert.deepEqual(parsed, { ok: true, request: { host: "192.168.1.50", port: 0, tls: false } });
  assert.equal(pairingAddress({ host: "192.168.1.50", port: 0, tls: false }), "ws://192.168.1.50");
  assert.equal(pairingAddress({ host: "nas", port: 3778, tls: true }), "wss://nas:3778");
});

test("pairing: bracketed IPv6 hosts are accepted", () => {
  const parsed = parsePairingParams({ host: "[fd7a:115c:a1e0::1]", port: "3000", tls: "0" });
  assert.equal(parsed.ok, true);
});

test("pairing: hosts that smuggle a scheme, path, port, userinfo or spaces are rejected", () => {
  const bad = [
    "", "   ", "ws://evil.example", "evil.example/path", "evil.example:3000",
    "user@evil.example", "evil.example?x=1", "evil example", "evil.example#frag",
    "-leadingdash.example", "a".repeat(254), "[not-ipv6]", "evil.example\nhost",
  ];
  for (const host of bad) {
    const parsed = parsePairingParams({ host });
    assert.equal(parsed.ok, false, `host ${JSON.stringify(host)} must be rejected`);
  }
});

test("pairing: bad ports, TLS flags and oversized passwords are rejected", () => {
  for (const port of ["0", "65536", "-1", "80a", "1e3", "999999"]) {
    assert.equal(parsePairingParams({ host: "nas", port }).ok, false, `port ${port}`);
  }
  assert.equal(parsePairingParams({ host: "nas", tls: "yes" }).ok, false);
  assert.equal(parsePairingParams({ host: "nas", pw: "x".repeat(513) }).ok, false);
  assert.equal(parsePairingParams({ host: "nas", port: "65535", tls: "true" }).ok, true);
});

test("config: publicPort defaults to port and follows IONSYNC_PUBLIC_PORT", () => {
  const before = process.env.IONSYNC_PUBLIC_PORT;
  try {
    delete process.env.IONSYNC_PUBLIC_PORT;
    assert.equal(mergeConfig({ password: "x", port: 3000 }).publicPort, 3000);
    assert.equal(mergeConfig({ password: "x", port: 3000, publicPort: 8443 }).publicPort, 8443);
    process.env.IONSYNC_PUBLIC_PORT = "3778";
    assert.equal(mergeConfig({ password: "x", port: 3000 }).publicPort, 3778);
    process.env.IONSYNC_PUBLIC_PORT = "not-a-port";
    assert.equal(mergeConfig({ password: "x", port: 3000 }).publicPort, 3000);
  } finally {
    if (before === undefined) delete process.env.IONSYNC_PUBLIC_PORT;
    else process.env.IONSYNC_PUBLIC_PORT = before;
  }
});

test("GET /api/pairing requires a dashboard session and never returns the password", async () => {
  const ts = await startTestServer();
  try {
    const anon = await fetch(`http://127.0.0.1:${ts.port}/api/pairing`);
    assert.equal(anon.status, 401);

    const login = await fetch(`http://127.0.0.1:${ts.port}/api/login`, {
      headers: { "x-dashboard-password": TEST_PASSWORD },
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const r = await fetch(`http://127.0.0.1:${ts.port}/api/pairing`, { headers: { cookie } });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(!text.includes(TEST_PASSWORD), "the sync password must not be readable from the dashboard API");
    const body = JSON.parse(text) as { port: unknown; tls: unknown };
    assert.equal(typeof body.port, "number");
    assert.equal(body.tls, false);
    assert.deepEqual(Object.keys(body).sort(), ["port", "tls"]);
  } finally {
    await ts.stop();
  }
});
