import type { Note } from "./vault.js";
import { noteMeta, matchesFilter, type NoteFilter } from "./meta.js";

export interface SearchHit {
  path: string;
  score: number;
  mtime: number;
  /** The note's own date (frontmatter, else filename, else last modified). */
  date: string;
  tags: string[];
  snippets: { line: number; text: string }[];
}

const MAX_SNIPPETS = 3;
const SNIPPET_CHARS = 240;

/**
 * Split a query into lowercase terms; "quoted phrases" stay together.
 * Every term must appear in the note (path or body) for it to match.
 */
export function parseQuery(q: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const t = (m[1] ?? m[2] ?? "").toLowerCase().trim();
    if (t) terms.push(t);
  }
  return terms;
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Text search, filter-only browse, or both. With no query terms every note
 * passing the filter is returned, newest note date first.
 */
export function searchNotes(notes: Iterable<Note>, query: string, opts: { prefix?: string; limit?: number; filter?: NoteFilter | null } = {}): SearchHit[] {
  const terms = parseQuery(query);
  if (terms.length === 0 && !opts.filter) return [];
  const hits: SearchHit[] = [];

  for (const note of notes) {
    if (note.kind !== "text" || note.text === null) continue;
    if (opts.prefix && !note.path.startsWith(opts.prefix)) continue;
    if (opts.filter && !matchesFilter(note, opts.filter)) continue;
    const body = note.text.toLowerCase();
    const path = note.path.toLowerCase();

    let score = 0;
    let all = true;
    for (const t of terms) {
      const inBody = countOccurrences(body, t);
      const inPath = path.includes(t);
      if (inBody === 0 && !inPath) { all = false; break; }
      // A title hit outweighs body hits; body hits saturate so one long note
      // repeating a word can't bury a short, on-topic one.
      score += Math.min(inBody, 10) + (inPath ? 8 : 0);
    }
    if (!all) continue;

    const snippets: SearchHit["snippets"] = [];
    const lines = note.text.split("\n");
    for (let i = 0; i < lines.length && snippets.length < MAX_SNIPPETS; i++) {
      const lower = lines[i]!.toLowerCase();
      const term = terms.find((t) => lower.includes(t));
      if (!term) continue;
      snippets.push({ line: i + 1, text: clip(lines[i]!, lower.indexOf(term)) });
    }
    const meta = noteMeta(note);
    hits.push({ path: note.path, score, mtime: note.mtime, date: meta.date, tags: meta.tags, snippets });
  }

  hits.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date) || b.mtime - a.mtime || a.path.localeCompare(b.path));
  return hits.slice(0, opts.limit ?? 20);
}

/** Trim a long line to a window around the match. */
function clip(line: string, at: number): string {
  const t = line.trim();
  if (t.length <= SNIPPET_CHARS) return t;
  const start = Math.max(0, at - 80);
  const piece = line.slice(start, start + SNIPPET_CHARS).trim();
  return (start > 0 ? "…" : "") + piece + (start + SNIPPET_CHARS < line.length ? "…" : "");
}
