/**
 * Note metadata for filtering: frontmatter, tags and a "note date".
 *
 * Derived lazily from the decrypted text and cached per mirror entry (a changed
 * note is a new entry, so the cache can never go stale).
 */
import type { Note } from "./vault.js";
import { ApiError } from "./errors.js";

export interface NoteMeta {
  /** Frontmatter fields, keys lowercased, every value as a list of strings. */
  frontmatter: Record<string, string[]>;
  /** Lowercased, without "#": frontmatter `tags` plus inline #tags. */
  tags: string[];
  /** The note's own date as YYYY-MM-DD (see `dateSource`). */
  date: string;
  /** Where `date` came from, most trusted first. */
  dateSource: "frontmatter" | "filename" | "modified";
  /** Last-modified day, YYYY-MM-DD. */
  modified: string;
}

/** Frontmatter keys that carry the note's own date, in priority order. */
const DATE_KEYS = ["date", "created", "created_at", "date_created", "date created", "creation date", "day"];

const cache = new WeakMap<Note, NoteMeta>();

export function noteMeta(note: Note): NoteMeta {
  let m = cache.get(note);
  if (!m) cache.set(note, (m = buildMeta(note)));
  return m;
}

function buildMeta(note: Note): NoteMeta {
  const text = note.text ?? "";
  const { fields, bodyStart } = parseFrontmatter(text);
  const tags = new Set<string>();
  for (const key of ["tags", "tag"]) {
    for (const v of fields[key] ?? []) {
      for (const t of v.split(/[,\s]+/)) addTag(tags, t);
    }
  }
  for (const t of inlineTags(text.slice(bodyStart))) addTag(tags, t);

  const modified = dayOf(note.mtime);
  let date = modified;
  let dateSource: NoteMeta["dateSource"] = "modified";
  const fm = DATE_KEYS.map((k) => fields[k]?.[0]).find((v): v is string => !!v && parseDay(v) !== null);
  const name = note.path.slice(note.path.lastIndexOf("/") + 1);
  const inName = /(\d{4})-(\d{2})-(\d{2})/.exec(name) ?? /(\d{4})-(\d{2})-(\d{2})/.exec(note.path);
  if (fm) {
    date = parseDay(fm)!;
    dateSource = "frontmatter";
  } else if (inName && validDay(inName[0])) {
    date = inName[0];
    dateSource = "filename";
  }
  return { frontmatter: fields, tags: [...tags].sort(), date, dateSource, modified };
}

function addTag(set: Set<string>, raw: string): void {
  const t = raw.trim().replace(/^#/, "").replace(/\/+$/, "").toLowerCase();
  if (t) set.add(t);
}

/**
 * A deliberately small YAML subset — what Obsidian properties actually use:
 * `key: value`, `key: [a, b]`, and `key:` followed by `- item` lines. Nested
 * maps and multi-line strings are skipped rather than misread.
 */
export function parseFrontmatter(text: string): { fields: Record<string, string[]>; bodyStart: number } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const fields: Record<string, string[]> = {};
  if (!m) return { fields, bodyStart: 0 };
  let current: string[] | null = null;
  for (const line of m[1]!.split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item) {
      if (current) pushValue(current, item[1]!);
      continue;
    }
    const kv = /^([^\s:#][^:]*?)\s*:(?:\s+(.*))?$/.exec(line);
    if (!kv) {
      if (line.trim() !== "" && !/^\s/.test(line)) current = null;
      continue;
    }
    current = fields[kv[1]!.toLowerCase()] = [];
    const v = (kv[2] ?? "").trim();
    if (v === "" || v === "|" || v === ">") continue;
    if (v.startsWith("[") && v.endsWith("]") && !v.startsWith("[[")) {
      for (const part of v.slice(1, -1).split(",")) pushValue(current, part);
    } else {
      pushValue(current, v);
    }
  }
  return { fields, bodyStart: m[0].length };
}

function pushValue(list: string[], raw: string): void {
  let v = raw.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
  // Obsidian link values: [[Note]] / [[Note|Alias]] -> Note
  const link = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(v);
  if (link) v = link[1]!;
  if (v !== "") list.push(v);
}

/** Inline #tags in the body, ignoring fenced and inline code. */
function inlineTags(body: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    if (inFence || !raw.includes("#")) continue;
    const line = raw.replace(/`[^`]*`/g, " ");
    const re = /(?:^|[\s(>])#([\p{L}\p{N}_/-]+)/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      // Obsidian: a tag must contain at least one non-digit character.
      if (/[^\d/]/.test(m[1]!)) out.push(m[1]!);
    }
  }
  return out;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local calendar day (process time zone — set TZ on the container). */
function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function validDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const mo = Number(m[2]);
  const da = Number(m[3]);
  return mo >= 1 && mo <= 12 && da >= 1 && da <= 31;
}

/** A frontmatter date value as YYYY-MM-DD, or null when it is not a date. */
function parseDay(v: string): string | null {
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/.exec(v.trim());
  if (iso) return validDay(iso[1]!) ? iso[1]! : null;
  if (!/\d{4}/.test(v)) return null; // require a year, or Date.parse guesses wildly
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : dayOf(t);
}

// ── Filters ─────────────────────────────────────────────────────────────────

export interface NoteFilter {
  tags: string[];
  frontmatter: { key: string; value: string | null }[];
  from: string | null;
  to: string | null;
  dateBy: "note" | "modified";
}

/** Expand YYYY, YYYY-MM or YYYY-MM-DD into an inclusive day range. */
function period(raw: string, name: string): { from: string; to: string } {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(raw.trim());
  const ok = m && (m[2] === undefined || (Number(m[2]) >= 1 && Number(m[2]) <= 12)) && (m[3] === undefined || validDay(raw.trim()));
  if (!m || !ok) {
    throw new ApiError(400, "bad_request", `"${name}" must be a date like 2026, 2026-09 or 2026-09-14.`);
  }
  const y = m[1]!;
  // "-31" sorts after every real day of any month, so no calendar maths needed.
  return { from: `${y}-${m[2] ?? "01"}-${m[3] ?? "01"}`, to: `${y}-${m[2] ?? "12"}-${m[3] ?? "31"}` };
}

/** Read filter parameters from a query string; null when none were given. */
export function parseFilter(q: URLSearchParams): NoteFilter | null {
  const tags = q.getAll("tag").flatMap((t) => t.split(",")).map((t) => t.trim().replace(/^#/, "").replace(/\/+$/, "").toLowerCase()).filter(Boolean);
  const frontmatter = q.getAll("frontmatter").filter((f) => f.trim() !== "").map((f) => {
    const i = f.indexOf(":");
    const key = (i === -1 ? f : f.slice(0, i)).trim().toLowerCase();
    const value = i === -1 ? null : f.slice(i + 1).trim().toLowerCase();
    if (!key) throw new ApiError(400, "bad_request", '"frontmatter" must look like "key" or "key:value".');
    return { key, value: value === "" ? null : value };
  });
  let from: string | null = null;
  let to: string | null = null;
  const date = q.get("date");
  if (date) ({ from, to } = period(date, "date"));
  const dateFrom = q.get("dateFrom");
  if (dateFrom) from = period(dateFrom, "dateFrom").from;
  const dateTo = q.get("dateTo");
  if (dateTo) to = period(dateTo, "dateTo").to;
  if (from && to && from > to) throw new ApiError(400, "bad_request", "The date range is empty: dateFrom is after dateTo.");
  const by = q.get("dateBy");
  if (by !== null && by !== "note" && by !== "modified") {
    throw new ApiError(400, "bad_request", '"dateBy" must be "note" or "modified".');
  }
  if (tags.length === 0 && frontmatter.length === 0 && !from && !to) return null;
  return { tags, frontmatter, from, to, dateBy: by === "modified" ? "modified" : "note" };
}

export function matchesFilter(note: Note, f: NoteFilter): boolean {
  // Only readable text notes have metadata to filter on.
  if (note.kind !== "text" || note.text === null) return false;
  const m = noteMeta(note);
  // A tag also matches its nested children: "sermon" matches "sermon/2026".
  for (const want of f.tags) {
    if (!m.tags.some((t) => t === want || t.startsWith(want + "/"))) return false;
  }
  for (const { key, value } of f.frontmatter) {
    const have = m.frontmatter[key];
    if (!have) return false;
    if (value !== null && !have.some((v) => v.toLowerCase().includes(value))) return false;
  }
  const day = f.dateBy === "modified" ? m.modified : m.date;
  if (f.from && day < f.from) return false;
  if (f.to && day > f.to) return false;
  return true;
}

/** Every tag in use with how many notes carry it, most used first. */
export function tagCounts(notes: Iterable<Note>, prefix: string): { tag: string; notes: number }[] {
  const counts = new Map<string, number>();
  for (const n of notes) {
    if (n.kind !== "text" || n.text === null) continue;
    if (prefix && !n.path.startsWith(prefix)) continue;
    for (const t of noteMeta(n).tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, c]) => ({ tag, notes: c }))
    .sort((a, b) => b.notes - a.notes || a.tag.localeCompare(b.tag));
}
