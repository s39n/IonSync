/**
 * OpenAPI description, served at /v1/openapi.json. Written for a model to read:
 * the descriptions say when and how to use each call, not just its shape.
 */
export function openApiSpec(serverUrl: string): Record<string, unknown> {
  const pathParam = {
    name: "path",
    in: "path",
    required: true,
    description: 'Vault-relative note path with forward slashes, URL-encoded, e.g. "Projects/Plan.md".',
    schema: { type: "string" },
  };
  const expectedSha1 = {
    type: "string",
    description: "The sha1 you got when you last read the note. If the note has changed since, the call fails with 409 instead of overwriting someone else's edit.",
  };
  const noteMeta = {
    type: "object",
    properties: {
      path: { type: "string" },
      sha1: { type: "string", description: "Content hash; pass it back as expectedSha1." },
      mtime: { type: "integer", description: "Last modified, ms since epoch." },
      size: { type: "integer" },
      kind: { type: "string", enum: ["text", "binary", "unreadable"] },
    },
  };
  const err = { description: "Error. Body: { error: { code, message } }. The message says how to recover." };

  return {
    openapi: "3.1.0",
    info: {
      title: "IonSync Notes API",
      version: "1",
      description:
        "Read, search, create and edit notes in an Obsidian vault synced by IonSync. " +
        "Changes appear on every synced device within seconds and are kept in version history. " +
        "Typical flow: getVaultTree for orientation, searchNotes to find a note, readNote (use outline or a line window for long notes), then editNote for small changes (preferred) or writeNote to create or replace. " +
        "To add a new note, call writeNote with createOnly: true and a path ending in .md. " +
        "Notes are Markdown; link between notes with [[Note Name]].",
    },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    paths: {
      "/v1/search": {
        get: {
          operationId: "searchNotes",
          summary: "Full-text search across note titles and bodies",
          description: 'Case-insensitive. Every word must appear in the note; wrap an exact phrase in double quotes. Results are ranked (title matches first) and include matching lines.',
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "prefix", in: "query", description: 'Only search under this folder, e.g. "Projects/".', schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
          ],
          responses: { "200": { description: "Ranked results with snippets." }, default: err },
        },
      },
      "/v1/tree": {
        get: {
          operationId: "getVaultTree",
          summary: "Folder overview of the vault",
          description: "Each folder with the number of files directly in it, the total beneath it, and when it last changed. Start here to learn how the vault is organised; far cheaper than listing every note.",
          parameters: [
            { name: "prefix", in: "query", description: 'Only this folder and below, e.g. "Projects/".', schema: { type: "string" } },
            { name: "depth", in: "query", description: "How many folder levels to return.", schema: { type: "integer", default: 3 } },
          ],
          responses: { "200": { description: "{ prefix, depth, totalFiles, folders: [{ path, files, total, latestMtime }] }" }, default: err },
        },
      },
      "/v1/notes": {
        get: {
          operationId: "listNotes",
          summary: "List notes and attachments",
          parameters: [
            { name: "prefix", in: "query", description: 'Folder to list, e.g. "Daily/".', schema: { type: "string" } },
            { name: "sort", in: "query", description: '"mtime" lists most recently changed first; default is by path.', schema: { type: "string", enum: ["path", "mtime"] } },
            { name: "limit", in: "query", schema: { type: "integer", default: 200, maximum: 1000 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { "200": { description: "{ total, offset, notes: [metadata] }" }, default: err },
        },
      },
      "/v1/notes/{path}": {
        parameters: [pathParam],
        get: {
          operationId: "readNote",
          summary: "Read a note (whole, a line window, or just its outline)",
          description: "With no query parameters, returns the full content. For long notes, first ask for outline=1 (headings with line numbers), then fetch only the lines you need with from/lines.",
          parameters: [
            { name: "outline", in: "query", description: "Set to 1 to return only the headings and their line numbers.", schema: { type: "string", enum: ["1"] } },
            { name: "from", in: "query", description: "First line to return (1-based).", schema: { type: "integer" } },
            { name: "lines", in: "query", description: "How many lines to return (default 200 when from is given).", schema: { type: "integer" } },
          ],
          responses: { "200": { description: "Note metadata plus `content`.", content: { "application/json": { schema: { ...noteMeta, properties: { ...noteMeta.properties, content: { type: "string" } } } } } }, default: err },
        },
        put: {
          operationId: "writeNote",
          summary: "Create a note, or replace its whole content",
          description: "Missing folders are created implicitly. To change part of an existing note, prefer PATCH.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              required: ["content"],
              properties: {
                content: { type: "string", description: "The complete new Markdown content." },
                createOnly: { type: "boolean", description: "Fail with 409 if the note already exists." },
                expectedSha1,
              },
            } } },
          },
          responses: { "200": { description: "Replaced." }, "201": { description: "Created." }, default: err },
        },
        patch: {
          operationId: "editNote",
          summary: "Make targeted edits to an existing note",
          description: "Operations apply in order; if any fails, nothing is changed.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              required: ["operations"],
              properties: {
                expectedSha1,
                operations: {
                  type: "array",
                  items: {
                    oneOf: [
                      { type: "object", required: ["op", "find", "replace"], properties: { op: { const: "replace" }, find: { type: "string", description: "Exact text to find. Must occur once unless `all` is true." }, replace: { type: "string" }, all: { type: "boolean" } } },
                      { type: "object", required: ["op", "text"], properties: { op: { const: "append" }, text: { type: "string" } }, description: "Add text at the end of the note." },
                      { type: "object", required: ["op", "text"], properties: { op: { const: "prepend" }, text: { type: "string" } }, description: "Add text at the top (after YAML frontmatter, if any)." },
                      { type: "object", required: ["op", "heading", "text"], properties: { op: { const: "insert_under_heading" }, heading: { type: "string", description: "Heading text, without the # marks." }, text: { type: "string" } }, description: "Add text at the end of the section under a heading." },
                    ],
                  },
                },
              },
            } } },
          },
          responses: { "200": { description: "Edited; returns new metadata." }, default: err },
        },
        delete: {
          operationId: "deleteNote",
          summary: "Delete a note",
          description: "The note is removed from every device. It stays recoverable from IonSync's version history for a limited time.",
          parameters: [{ name: "expectedSha1", in: "query", schema: { type: "string" } }],
          responses: { "200": { description: "Deleted." }, default: err },
        },
      },
      "/v1/move": {
        post: {
          operationId: "moveNote",
          summary: "Rename or move a note",
          description: "Keeps the note's version history. Fails with 409 if the destination exists. Links in other notes are not rewritten.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["from", "to"], properties: { from: { type: "string" }, to: { type: "string" } } } } },
          },
          responses: { "200": { description: "Moved; returns metadata of the note at its new path." }, default: err },
        },
      },
      "/v1/health": {
        get: { operationId: "health", summary: "Liveness; no token needed", security: [], responses: { "200": { description: "{ ok, connected, synced }" } } },
      },
    },
  };
}
