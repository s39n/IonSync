/**
 * Pure-logic tests: no sync server, no sqlite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { E2ee, blobVersion } from "../src/e2ee.js";
import { applyEdits, parseEditOps } from "../src/edits.js";
import { searchNotes, parseQuery } from "../src/search.js";
import { isHiddenPath, isTextPath, isValidVaultPath } from "../src/paths.js";
import { loadConfig, defaultDeviceId } from "../src/config.js";
import { ApiError } from "../src/errors.js";
import type { Note } from "../src/vault.js";
// The plugin's WebCrypto implementation — the format we must stay compatible with.
import * as PluginCrypto from "../../plugin/src/Crypto.js";

const SALT_HEX = "00112233445566778899aabbccddeeff";

test("e2ee: decrypts what the plugin encrypts (v2 and v3)", async () => {
  const e2ee = new E2ee("vault-pass");
  e2ee.setInstallSalt(SALT_HEX);
  PluginCrypto.setInstallSalt(SALT_HEX);
  for (const version of [2, 3]) {
    const key = await PluginCrypto.deriveKey("vault-pass", version);
    const blob = await PluginCrypto.encryptToBytes(key, new TextEncoder().encode(`héllo v${version}`), version);
    assert.equal(blobVersion(blob), version);
    assert.equal(e2ee.decrypt(blob).toString("utf8"), `héllo v${version}`);
  }
});

test("e2ee: the plugin decrypts what the API encrypts (v2 and v3)", async () => {
  const e2ee = new E2ee("vault-pass");
  e2ee.setInstallSalt(SALT_HEX);
  PluginCrypto.setInstallSalt(SALT_HEX);
  for (const version of [2, 3]) {
    const blob = e2ee.encrypt(Buffer.from(`from the api v${version}`), version);
    const plain = await PluginCrypto.decryptFromBytes(new Uint8Array(blob), "vault-pass");
    assert.equal(new TextDecoder().decode(plain), `from the api v${version}`);
  }
});

test("e2ee: wrong password and tampering are rejected; v3 needs the salt", () => {
  const blob = new E2ee("right").encrypt(Buffer.from("secret"), 2);
  assert.throws(() => new E2ee("wrong").decrypt(blob));
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1]! ^= 1;
  assert.throws(() => new E2ee("right").decrypt(tampered));
  assert.equal(new E2ee("right").supports(3), false);
  assert.throws(() => new E2ee("right").encrypt(Buffer.from("x"), 3));
  assert.equal(blobVersion(Buffer.from("# just a note")), null);
});

test("edits: replace must be unambiguous", () => {
  assert.equal(applyEdits("a b c", [{ op: "replace", find: "b", replace: "B" }]), "a B c");
  assert.equal(applyEdits("x x", [{ op: "replace", find: "x", replace: "y", all: true }]), "y y");
  assert.throws(() => applyEdits("x x", [{ op: "replace", find: "x", replace: "y" }]), (e) => e instanceof ApiError && e.code === "edit_ambiguous");
  assert.throws(() => applyEdits("abc", [{ op: "replace", find: "z", replace: "y" }]), (e) => e instanceof ApiError && e.code === "edit_no_match");
});

test("edits: append, prepend (after frontmatter), insert under heading", () => {
  assert.equal(applyEdits("line", [{ op: "append", text: "more" }]), "line\nmore");
  assert.equal(applyEdits("line\n", [{ op: "append", text: "more" }]), "line\nmore");
  assert.equal(applyEdits("", [{ op: "append", text: "first" }]), "first");
  assert.equal(applyEdits("---\ntags: [a]\n---\nbody", [{ op: "prepend", text: "top" }]), "---\ntags: [a]\n---\ntop\nbody");
  assert.equal(applyEdits("body", [{ op: "prepend", text: "top" }]), "top\nbody");

  const doc = "# Title\n\n## Tasks\n- one\n\n## Notes\ntext\n";
  assert.equal(
    applyEdits(doc, [{ op: "insert_under_heading", heading: "Tasks", text: "- two" }]),
    "# Title\n\n## Tasks\n- one\n- two\n\n## Notes\ntext\n"
  );
  // Last section: goes to the end of the note.
  assert.equal(applyEdits(doc, [{ op: "insert_under_heading", heading: "## notes", text: "more" }]), doc + "more");
  // A "# heading" inside a code fence is not a heading.
  const fenced = "## A\n```\n## B\n```\ntail";
  assert.throws(() => applyEdits(fenced, [{ op: "insert_under_heading", heading: "B", text: "x" }]), (e) => e instanceof ApiError && e.code === "edit_no_match");
});

test("edits: operations are validated", () => {
  assert.throws(() => parseEditOps([]));
  assert.throws(() => parseEditOps([{ op: "nope" }]));
  assert.throws(() => parseEditOps([{ op: "replace", find: "", replace: "x" }]));
  assert.deepEqual(parseEditOps([{ op: "append", text: "x" }]), [{ op: "append", text: "x" }]);
});

test("search: AND terms, phrases, title boost, snippets", () => {
  const note = (path: string, text: string, mtime = 1): Note => ({ path, text, mtime, sha1: "", size: text.length, kind: "text" });
  const notes = [
    note("Recipes/Vanilla Ice Cream.md", "Cream, sugar, vanilla.\nChurn for 20 minutes."),
    note("Journal.md", "Made ice cream today. The vanilla one was best. vanilla vanilla"),
    note("Other.md", "Nothing relevant."),
    { ...note("photo.png", ""), kind: "binary" as const, text: null },
  ];
  assert.deepEqual(parseQuery('ice "vanilla one"'), ["ice", "vanilla one"]);

  const hits = searchNotes(notes, "vanilla cream");
  assert.deepEqual(hits.map((h) => h.path), ["Recipes/Vanilla Ice Cream.md", "Journal.md"]);
  assert.equal(hits[0]!.snippets[0]!.line, 1);

  assert.deepEqual(searchNotes(notes, '"vanilla one"').map((h) => h.path), ["Journal.md"]);
  assert.deepEqual(searchNotes(notes, "vanilla", { prefix: "Recipes/" }).map((h) => h.path), ["Recipes/Vanilla Ice Cream.md"]);
  assert.deepEqual(searchNotes(notes, "vanilla churn sugar missing"), []);
});

test("paths: validity, hidden, text", () => {
  for (const bad of ["", "/abs.md", "a/../b.md", "./a.md", "a//b.md", "a\\b.md", "a/", 5]) {
    assert.equal(isValidVaultPath(bad), false, String(bad));
  }
  assert.equal(isValidVaultPath("Folder/Note.md"), true);
  assert.equal(isHiddenPath(".obsidian/app.json"), true);
  assert.equal(isHiddenPath("a/.trash/x.md"), true);
  assert.equal(isHiddenPath("OBSIDI~1/app.json"), true);
  assert.equal(isHiddenPath("a/b.md"), false);
  assert.equal(isTextPath("a/b.MD"), true);
  assert.equal(isTextPath("a/b.png"), false);
  assert.equal(isTextPath("noext"), false);
});

test("config: disabled until a strong token is set", () => {
  assert.ok("disabled" in loadConfig({}));
  assert.ok("disabled" in loadConfig({ IONSYNC_API_TOKEN: "short", IONSYNC_PASSWORD: "p" }));
  assert.ok("disabled" in loadConfig({ IONSYNC_API_TOKEN: "x".repeat(32) }));
  const cfg = loadConfig({ IONSYNC_API_TOKEN: "x".repeat(32), IONSYNC_PASSWORD: "p" });
  assert.ok(!("disabled" in cfg));
  assert.equal(cfg.deviceId, defaultDeviceId("p"));
  assert.match(cfg.deviceId, /^[0-9A-Za-z_-]{1,64}$/); // must satisfy the server's device-id rule
  assert.equal(cfg.e2eePassword, null);
});
