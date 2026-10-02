/**
 * Runs the LLM API against a throwaway sync server with a small sample vault
 * and prints a few real requests and responses. Nothing touches your own data.
 *
 *   npm run demo -w packages/api            # human-readable transcript
 *   npm run demo -w packages/api -- out.json  # also save it as JSON
 *
 * The screenshot in the README is rendered from this output.
 */
import fs from "node:fs";
import { startTestServer, TEST_PASSWORD } from "../../server/test/helpers.js";
import { createGateway } from "../src/gateway.js";

const TOKEN = "demo-token-0123456789abcdef-demo";

const VAULT: Record<string, string> = {
  "Sermons/2026-09-06 Grace.md": "---\ntype: sermon\nspeaker: John Smith\ntags: [sermon]\n---\n# Grace\n\nGrace abounds where it is least expected. #prayer\n\n## Follow-up\n- Read Romans 5\n",
  "Sermons/2026-09-20 Hope.md": "---\ntype: sermon\nspeaker: Ann Lee\ntags: [sermon]\n---\n# Hope\n\nHope endures through the long night.\n",
  "Sermons/2026-08-30 Faith.md": "---\ntype: sermon\ntags: [sermon]\n---\n# Faith\n\nFaith without works. #prayer\n",
  "Journal/2026-09-10.md": "Prayed about grace this morning. #prayer #journal\n",
  "Recipes/Vanilla Ice Cream.md": "---\ntags: [recipe]\n---\n# Vanilla Ice Cream\n\nCream, sugar, vanilla. Churn for 20 minutes.\n",
};

// Keep the demo transcript free of the sync server's own log lines.
const quiet = console.log;
console.log = () => undefined;
console.error = () => undefined;

const srv = await startTestServer({ logs: { level: 0 } });
const gw = createGateway({
  serverUrl: `ws://127.0.0.1:${srv.port}`,
  password: TEST_PASSWORD,
  e2eePassword: "demo-vault-password",
  e2eeVersion: null,
  token: TOKEN,
  readToken: null,
  port: 0,
  host: "127.0.0.1",
  publicUrl: null,
  trustProxy: false,
  deviceId: "llm-api-demo",
  deviceName: "LLM API",
  maxDeletesPerHour: 60,
  maxNoteBytes: 5 * 1024 * 1024,
  log: () => undefined,
});
const port = await gw.listen();
await gw.vault.whenSynced();

const transcript: { command: string; status: number; body: unknown }[] = [];

async function call(method: string, path: string, body?: unknown, record = true): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json: unknown = await res.json();
  if (!record) return;
  const data = body !== undefined ? ` -d '${JSON.stringify(body)}'` : "";
  transcript.push({
    command: `curl ${method === "GET" ? "" : `-X ${method} `}-H "Authorization: Bearer $TOKEN" "$API${path}"${data}`,
    status: res.status,
    body: json,
  });
}

for (const [path, content] of Object.entries(VAULT)) {
  await call("PUT", `/v1/notes/${path.split("/").map(encodeURIComponent).join("/")}`, { content }, false);
}

await call("GET", "/v1/search?q=grace&tag=sermon&date=2026-09");
await call("PATCH", "/v1/notes/Sermons/2026-09-06%20Grace.md", {
  operations: [{ op: "insert_under_heading", heading: "Follow-up", text: "- Share notes with the study group" }],
});
await call("GET", "/v1/tags");
await call("GET", "/v1/tree?depth=1");

// What the sync server actually stores for a note: ciphertext only.
const stored = srv.ctx.storage.readLatest("Sermons/2026-09-06 Grace.md");
const storedPreview = stored ? `${stored.subarray(0, 8).toString("ascii")} + ${stored.length - 8} encrypted bytes` : "(missing)";

await gw.close();
await srv.stop();
console.log = quiet;

for (const t of transcript) {
  console.log(`$ ${t.command}`);
  console.log(`HTTP ${t.status}`);
  console.log(JSON.stringify(t.body, null, 2));
  console.log("");
}
console.log(`Stored on the sync server: ${storedPreview}`);

const out = process.argv[2];
if (out) fs.writeFileSync(out, JSON.stringify({ transcript, storedPreview }, null, 2));
