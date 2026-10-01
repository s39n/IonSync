# IonSync LLM API

A small REST API that lets an LLM (or any script) work with your vault: **search, list, read, create, edit, move and delete notes**. Changes show up on every synced device within seconds and land in IonSync's version history like any other edit.

## How it works

The API is a separate process that logs in to the IonSync server as an ordinary sync device (it appears in the dashboard as **"LLM API"**). It keeps a decrypted copy of your text notes **in memory only** and sends writes with the same messages the Obsidian plugin uses.

- **End-to-end encryption stays intact.** The sync server still only stores ciphertext. The vault password lives in the API process, never on the server, and plaintext is never written to disk.
- **No silent overwrites.** Writes pass through the server's conflict gate. If a note changed on another device at the same moment, the API returns `409` and the losing text is kept as a conflict record you can review in the plugin or dashboard.
- **Recoverable.** Edits and deletes are versioned by the server (`IONSYNC_VERSIONS_PER_FILE`, `IONSYNC_KEEP_DELETED_SECS`).

## Enable it (Docker)

The `ionsync-api` service ships in `docker-compose.yml` and idles until it has a token.

1. Generate a token: `openssl rand -hex 32`
2. Add to your `.env` / stack variables:

   | Variable | Required | Description |
   |---|---|---|
   | `IONSYNC_API_TOKEN` | yes | Bearer token with full access. At least 24 characters. |
   | `IONSYNC_E2EE_PASSWORD` | if the vault is encrypted | The encryption password set in the plugin. Without it, encrypted notes are reported as unreadable and cannot be overwritten. |
   | `IONSYNC_API_READ_TOKEN` | no | A second token that can only list, read and search. |
   | `IONSYNC_API_PORT` | no | Host port (default `3002`). |
   | `IONSYNC_API_TRUST_PROXY` | behind a proxy/tunnel | Set to `1` so rate limiting sees the real client address (`CF-Connecting-IP` / `X-Forwarded-For`). |
   | `IONSYNC_API_E2EE_VERSION` | no | Force the encryption format for writes (`2` or `3`). By default the API writes the newest format already present in the vault, so it never produces notes an older device cannot read. |
   | `IONSYNC_API_MAX_DELETES_PER_HOUR` | no | Runaway-deletion guard (default `60`). |

3. Redeploy, then check: `curl http://<host>:3002/v1/health` → `{"ok":true,...}`

To reach it from outside your network, put it behind HTTPS (reverse proxy or a Cloudflare tunnel hostname pointing at port 3002) and set `IONSYNC_API_TRUST_PROXY=1`. **Never expose the port over plain HTTP on the internet** — the token travels in a header.

Without Docker: `npm run build -w packages/api`, then run `node packages/api/dist/index.js` with the variables above plus `IONSYNC_PASSWORD` and `IONSYNC_API_SERVER_URL=ws://<server>:<port>`.

## Endpoints

All calls except `health` and `openapi.json` need `Authorization: Bearer <token>`. Note paths are vault-relative with forward slashes, URL-encoded (`Projects/My%20Plan.md`).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/search?q=…&prefix=…&limit=…` | Full-text search. Every word must match; `"quoted phrases"` supported. Ranked, with matching lines. |
| `GET` | `/v1/notes?prefix=…&sort=mtime&limit=…&offset=…` | List notes (metadata only). |
| `GET` | `/v1/notes/{path}` | Read a note: `{ path, content, sha1, mtime, size }`. |
| `PUT` | `/v1/notes/{path}` | Create or replace. Body: `{ content, createOnly?, expectedSha1? }`. |
| `PATCH` | `/v1/notes/{path}` | Targeted edits. Body: `{ operations: [...], expectedSha1? }`. All-or-nothing. |
| `DELETE` | `/v1/notes/{path}` | Delete a note. |
| `POST` | `/v1/move` | Rename/move. Body: `{ from, to }`. History follows the note. |
| `GET` | `/v1/openapi.json` | OpenAPI 3.1 spec — import this to generate LLM tools. |
| `GET` | `/v1/health` | `{ ok, connected, synced }`. |

Edit operations:

```json
{ "operations": [
  { "op": "replace", "find": "exact text", "replace": "new text" },
  { "op": "append", "text": "added at the end" },
  { "op": "prepend", "text": "added at the top, after frontmatter" },
  { "op": "insert_under_heading", "heading": "Tasks", "text": "- [ ] new task" }
] }
```

`replace` must match exactly once unless `"all": true`. Pass the `sha1` from your last read as `expectedSha1` to fail with `409` instead of writing over a newer version.

Errors are `{ "error": { "code", "message" } }`; the message is written so a model can recover (re-read, make `find` unique, and so on).

```bash
TOKEN=...; API=https://notes.example.com
curl -H "Authorization: Bearer $TOKEN" "$API/v1/search?q=ice+cream"
curl -H "Authorization: Bearer $TOKEN" "$API/v1/notes/Recipes/Vanilla.md"
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"# Idea\n\nCaptured by an LLM.\n"}' "$API/v1/notes/Inbox/Idea.md"
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"operations":[{"op":"append","text":"- follow up"}]}' "$API/v1/notes/Inbox/Idea.md"
```

## What it will not do

- Touch hidden or config paths (`.obsidian/…`, `.trash/…`, any dot-folder) — they are invisible to the API.
- Read or write binary attachments. They are listed (`kind: "binary"`) and can be moved or deleted, nothing more. Writable extensions: `md`, `txt`, `canvas`, `base`, `csv`, `tsv`, `json`, `yaml`, `org`, `tex`, `html`, `css`, `js`, `ts`.
- Move or delete whole folders (one note per call).
- Rewrite `[[links]]` in other notes after a move.

## Operational notes

- On start the API downloads the vault once to build its in-memory index; until then calls return `503 syncing`. Attachments are downloaded but not kept.
- The API counts as a device. If you retire it permanently, remove the "LLM API" device in the dashboard so it does not hold back cleanup of deleted-file records.
- Ten failed tokens from one address within five minutes block that address until the window ends.
