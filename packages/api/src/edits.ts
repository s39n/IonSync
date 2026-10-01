import { ApiError } from "./errors.js";

/**
 * Targeted edits, so a model changes part of a note without resending (and
 * possibly mangling) the whole thing.
 */
export type EditOp =
  | { op: "replace"; find: string; replace: string; all?: boolean }
  | { op: "append"; text: string }
  | { op: "prepend"; text: string }
  | { op: "insert_under_heading"; heading: string; text: string };

export function parseEditOps(raw: unknown): EditOp[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError(400, "bad_request", '"operations" must be a non-empty array.');
  }
  if (raw.length > 100) throw new ApiError(400, "bad_request", "At most 100 operations per request.");
  return raw.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const str = (k: string): string => {
      const v = o[k];
      if (typeof v !== "string") throw new ApiError(400, "bad_request", `operations[${i}].${k} must be a string.`);
      return v;
    };
    switch (o["op"]) {
      case "replace": {
        const find = str("find");
        if (find === "") throw new ApiError(400, "bad_request", `operations[${i}].find must not be empty.`);
        return { op: "replace", find, replace: str("replace"), all: o["all"] === true };
      }
      case "append":
        return { op: "append", text: str("text") };
      case "prepend":
        return { op: "prepend", text: str("text") };
      case "insert_under_heading":
        return { op: "insert_under_heading", heading: str("heading"), text: str("text") };
      default:
        throw new ApiError(400, "bad_request", `operations[${i}].op must be one of: replace, append, prepend, insert_under_heading.`);
    }
  });
}

export function applyEdits(text: string, ops: EditOp[]): string {
  let out = text;
  ops.forEach((op, i) => { out = applyOne(out, op, i); });
  return out;
}

function applyOne(text: string, op: EditOp, index: number): string {
  switch (op.op) {
    case "replace": {
      const count = text.split(op.find).length - 1;
      if (count === 0) {
        throw new ApiError(422, "edit_no_match", `operations[${index}]: "find" text was not found in the note. It must match exactly, including whitespace.`);
      }
      if (count > 1 && !op.all) {
        throw new ApiError(422, "edit_ambiguous", `operations[${index}]: "find" text occurs ${count} times. Include more surrounding text to make it unique, or set "all": true.`);
      }
      return text.split(op.find).join(op.replace);
    }
    case "append":
      return joinBlocks(text, op.text);
    case "prepend": {
      // Keep YAML frontmatter at the very top.
      const fm = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(text);
      const head = fm ? fm[0] : "";
      const body = text.slice(head.length);
      const block = op.text.endsWith("\n") ? op.text : op.text + "\n";
      return (head && !head.endsWith("\n") ? head + "\n" : head) + block + body;
    }
    case "insert_under_heading": {
      const lines = text.split("\n");
      const want = op.heading.replace(/^#+\s*/, "").trim().toLowerCase();
      let start = -1;
      let level = 0;
      let inFence = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
        if (inFence) continue;
        const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (!m) continue;
        if (start === -1) {
          if (m[2]!.trim().toLowerCase() === want) { start = i; level = m[1]!.length; }
        } else if (m[1]!.length <= level) {
          return insertAt(lines, i, op.text);
        }
      }
      if (start === -1) {
        throw new ApiError(422, "edit_no_match", `operations[${index}]: no heading "${op.heading}" in the note.`);
      }
      return joinBlocks(text, op.text);
    }
  }
}

/** Append `add` as its own line(s), without piling up blank lines. */
function joinBlocks(text: string, add: string): string {
  if (text === "") return add;
  return text + (text.endsWith("\n") ? "" : "\n") + add;
}

/** Insert `add` at the end of the section that ends before line `at`. */
function insertAt(lines: string[], at: number, add: string): string {
  let end = at;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  const before = lines.slice(0, end);
  const after = lines.slice(at);
  return [...before, ...add.replace(/\n+$/, "").split("\n"), "", ...after].join("\n");
}
