import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { type Observation, indexRoot, observationDir } from "./memory";
import { type Candidate, type Doc, type Hit, normalize, searchText, tokenize } from "./search";

/**
 * A persistent postings index over one project's observations, so a prompt does not re-read and
 * re-tokenize every session log. Notes and team items are not indexed: they are few, and their
 * visibility and lifecycle are decided when read.
 *
 * Two files per project under <data dir>/index/<project>/:
 * - `base.idx`, written whole (temp file + rename) by a rebuild. Tab-separated lines:
 *   `engram-index <version> <docs>`; `F <file> <bytes>` per session log; `D <file> <id> <session>
 *   <prompt> <offset> <length> <len> <kind> <title> <ts> <weight>` per observation in log order;
 *   `T <term> <ref>[:<tf>],…` per token (a tf of 1 is left out); `C <chunk> <ref>,…` per
 *   whitespace-delimited chunk of the normalized search text; and `end`. Refs number the D lines.
 *   Display text is not stored: the few hits that are shown are re-read from their log at
 *   `offset`, so they read exactly as a full scan shows them.
 * - `delta.jsonl`, one appended line per observation captured since the rebuild: the same fields
 *   with its display text, tokens and chunks. Appends are whole lines, so parallel capture hooks do
 *   not collide.
 *
 * Search looks at the chunks because the full scan's substring prefilter decides which docs the
 * average length runs over, and a query term (never whitespace) can only sit inside one chunk.
 * Reproducing that set keeps indexed results identical to the full scan.
 *
 * Freshness: the bytes indexed per session log (base plus deltas) must equal each log's size, and
 * the set of logs must match. Anything else (a capture whose delta is not written yet, a pruned or
 * rewritten log, a torn line, a missing or corrupt index) makes the search fall back to a full scan
 * and the index is rebuilt. Rewrites that can keep a log's size (resanitize) drop the index
 * explicitly (memory.invalidateIndex).
 */

const VERSION = 3;
/** A delta past this size is folded into a new base by the next async hook. */
const DELTA_FOLD_BYTES = 1_000_000;

/** What a search needs from one observation before it is known to be shown. */
interface Entry {
  file: string;
  id: string;
  session: string;
  prompt: boolean;
  len: number;
  kind: string;
  title: string;
  ts: number;
  weight: number;
  /** Where a base entry's record sits in its log. */
  offset: number;
  length: number;
  /** Display and group of a delta entry, which has no known offset. */
  shown?: [string, string | null];
}

const dirOf = (project: string) => join(indexRoot(), project);
const baseFile = (project: string) => join(dirOf(project), "base.idx");
const deltaFile = (project: string) => join(dirOf(project), "delta.jsonl");

/** Tabs and newlines would break a line; ids, sessions and tool names almost never hold them. */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
const unesc = (s: string) =>
  s.includes("\\")
    ? s.replace(/\\([\\tn])/g, (_, c) => (c === "t" ? "\t" : c === "n" ? "\n" : "\\"))
    : s;

/** Tokens and chunks of a doc, computed the way search() sees it. */
function analyze(doc: Doc): { tf: Map<string, number>; len: number; chunks: string[] } {
  const text = searchText(doc);
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  const chunks = [...new Set(normalize(text).split(/\s+/))].filter(Boolean);
  return { tf, len: tokens.length, chunks };
}

/** Session logs of the project in directory order (the full scan's order) with their sizes. */
function sessionLogs(project: string): Array<{ file: string; size: number }> {
  const dir = observationDir(project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((file) => ({ file, size: statSync(join(dir, file)).size }));
}

/**
 * Records one captured observation, right after it was appended to its log. Without a base there is
 * nothing to extend; the next search builds one.
 */
export function indexObservation(project: string, o: Observation, doc: Doc, file: string): void {
  if (!existsSync(baseFile(project))) return;
  const { tf, len, chunks } = analyze(doc);
  // The bytes the log grew by: the record's JSON line. A torn line before it adds a byte this
  // cannot see, and the size check then rebuilds.
  const bytes = Buffer.byteLength(JSON.stringify(o)) + 1;
  const d = [o.id, o.session, o.tool === "prompt" ? 1 : 0, len, doc.kind, doc.title, doc.ts];
  const line = JSON.stringify({
    f: file,
    b: bytes,
    d: [...d, doc.weight, doc.display ?? "", doc.group ?? null],
    t: Object.fromEntries(tf),
    c: chunks,
  });
  appendFileSync(deltaFile(project), `${line}\n`, "utf-8");
}

/**
 * Rebuilds the base from the session logs. The delta is moved aside first: a capture racing the
 * rebuild then lands in the new delta, and if the rebuild also read its log line, the bytes count
 * twice and the size check rejects the index instead of serving a wrong one.
 */
export function rebuildIndex(project: string, toDoc: (o: Observation) => Doc): void {
  const dir = dirOf(project);
  mkdirSync(dir, { recursive: true });
  const aside = `${deltaFile(project)}.${process.pid}.old`;
  try {
    renameSync(deltaFile(project), aside);
  } catch {
    // No delta yet.
  }
  const files: string[] = [];
  const docs: string[] = [];
  const terms = new Map<string, string[]>();
  const chunkRefs = new Map<string, number[]>();
  const logDir = observationDir(project);
  if (existsSync(logDir)) {
    for (const file of readdirSync(logDir).filter((f) => f.endsWith(".jsonl"))) {
      const raw = readFileSync(join(logDir, file));
      files.push(`F\t${file}\t${raw.length}`);
      for (let start = 0; start < raw.length;) {
        const nl = raw.indexOf(0x0a, start);
        const end = nl === -1 ? raw.length : nl;
        const offset = start;
        start = end + 1;
        if (end === offset) continue;
        let o: Observation;
        try {
          o = JSON.parse(raw.toString("utf-8", offset, end));
        } catch {
          continue; // A torn line from a crashed writer, skipped like readLines() does.
        }
        const doc = toDoc(o);
        const { tf, len, chunks } = analyze(doc);
        const ref = docs.length;
        docs.push(
          [
            "D",
            file,
            esc(o.id),
            esc(o.session),
            o.tool === "prompt" ? 1 : 0,
            offset,
            end - offset,
            len,
            esc(doc.kind),
            esc(doc.title),
            doc.ts,
            doc.weight,
          ].join("\t"),
        );
        for (const [t, n] of tf) {
          const posting = n === 1 ? String(ref) : `${ref}:${n}`;
          const list = terms.get(t);
          if (list) list.push(posting);
          else terms.set(t, [posting]);
        }
        for (const c of chunks) {
          const list = chunkRefs.get(c);
          if (list) list.push(ref);
          else chunkRefs.set(c, [ref]);
        }
      }
    }
  }
  const out = [`engram-index\t${VERSION}\t${docs.length}`, ...files, ...docs];
  for (const [t, refs] of terms) out.push(`T\t${t}\t${refs.join(",")}`);
  for (const [c, refs] of chunkRefs) out.push(`C\t${c}\t${refs.join(",")}`);
  out.push("end", "");
  const tmp = `${baseFile(project)}.${process.pid}.tmp`;
  writeFileSync(tmp, out.join("\n"), "utf-8");
  renameSync(tmp, baseFile(project));
  try {
    unlinkSync(aside);
  } catch {
    // There was no delta to set aside.
  }
}

/** True when the delta has grown enough that the next async hook should fold it. */
export function indexNeedsFold(project: string): boolean {
  try {
    return statSync(deltaFile(project)).size > DELTA_FOLD_BYTES;
  } catch {
    return false;
  }
}

/** Observation filters a search applies (see hooks.obsVisible). */
export type Visible = (o: { id: string; session: string; prompt: boolean }) => boolean;

/** Calls `each(ref, tf)` for every posting in `line` from `from` on: `3,7:2,9` → (3,1) (7,2) (9,1). */
function postings(line: string, from: number, each: (ref: number, tf: number) => void): void {
  let ref = 0;
  let tf = 0;
  let inTf = false;
  for (let k = from; k <= line.length; k++) {
    const c = k < line.length ? line.charCodeAt(k) : 44;
    if (c === 44) {
      each(ref, inTf ? tf : 1);
      ref = 0;
      tf = 0;
      inTf = false;
    } else if (c === 58) inTf = true;
    else if (inTf) tf = tf * 10 + c - 48;
    else ref = ref * 10 + c - 48;
  }
}

export interface IndexedObservations {
  /** How many observations pass the filters: the corpus size search() would count. */
  total: number;
  /** Substring candidates in full-scan order, with the frequencies of the query terms. */
  cands: Candidate[];
  /** Adds display text and file group to the hits that came from the index. */
  fill: (hits: Hit[]) => Hit[];
}

/**
 * The project's observations as search() would see them after `visible`. Returns null when the
 * index is missing or stale; the caller then scans. Throws on a damaged file, which callers treat
 * the same way. `toDoc` turns a re-read record into the doc a full scan would show.
 */
export function indexedCandidates(
  project: string,
  qTerms: string[],
  visible: Visible,
  toDoc: (o: Observation) => Doc,
): IndexedObservations | null {
  let base: string;
  try {
    base = readFileSync(baseFile(project), "utf-8");
  } catch {
    return null;
  }
  const lines = base.split("\n");
  const head = lines[0].split("\t");
  // Written whole through a rename, so a short file means a foreign or damaged one.
  if (
    head[0] !== "engram-index" ||
    Number(head[1]) !== VERSION ||
    lines[lines.length - 2] !== "end"
  )
    return null;
  const count = Number(head[2]);
  const indexed = new Map<string, number>();
  let i = 1;
  for (; lines[i].startsWith("F\t"); i++) {
    const [, file, bytes] = lines[i].split("\t");
    indexed.set(file, Number(bytes));
  }
  const docsAt = i;
  const termsAt = docsAt + count;
  if (count && !lines[termsAt - 1].startsWith("D\t")) return null;
  if (lines[termsAt] !== "end" && !/^[TC]\t/.test(lines[termsAt])) return null;

  type DeltaLine = {
    f: string;
    b: number;
    d: [string, string, 0 | 1, number, string, string, number, number, string, string | null];
    t: Record<string, number>;
    c: string[];
  };
  const deltas: DeltaLine[] = [];
  let delta = "";
  try {
    delta = readFileSync(deltaFile(project), "utf-8");
  } catch {
    // No captures since the rebuild.
  }
  for (const line of delta.split("\n")) {
    // A torn delta line throws: the index is then treated as damaged, never as complete.
    if (line) deltas.push(JSON.parse(line) as DeltaLine);
  }
  for (const r of deltas) indexed.set(r.f, (indexed.get(r.f) || 0) + r.b);
  const logs = sessionLogs(project);
  if (logs.some((l) => (indexed.get(l.file) || 0) !== l.size)) return null;
  const present = new Set(logs.map((l) => l.file));
  for (const [file, bytes] of indexed) if (bytes && !present.has(file)) return null;

  // Substring candidates: every doc holding a chunk that contains a query term.
  const hit = (text: string) => qTerms.some((q) => text.includes(q));
  const cand = new Set<number>();
  if (qTerms.length) {
    for (let k = termsAt; lines[k] !== "end"; k++) {
      const line = lines[k];
      if (line.charCodeAt(0) !== 67) continue; // "C"
      const tab = line.indexOf("\t", 2);
      if (hit(line.slice(2, tab))) postings(line, tab + 1, (ref) => cand.add(ref));
    }
    deltas.forEach((r, k) => {
      if (r.c.some(hit)) cand.add(count + k);
    });
  }

  // Only candidates can hold a query term, so their frequencies are all scoring needs.
  const tfs = new Map<number, number[]>();
  for (const ref of cand) tfs.set(ref, new Array(qTerms.length).fill(0));
  qTerms.forEach((q, j) => {
    const at = base.indexOf(`\nT\t${q}\t`);
    if (at !== -1) {
      const line = base.slice(at + 1, base.indexOf("\n", at + 1));
      postings(line, line.indexOf("\t", 2) + 1, (ref, tf) => {
        const row = tfs.get(ref);
        if (row) row[j] = tf;
      });
    }
    deltas.forEach((r, k) => {
      const row = tfs.get(count + k);
      if (row && Object.prototype.hasOwnProperty.call(r.t, q)) row[j] = r.t[q];
    });
  });

  // Base entries are grouped by log in F order and deltas follow, so placing them in today's
  // directory order (the full scan's order) needs no sort.
  const entryOf = (k: number): Entry => {
    if (k >= count) {
      const r = deltas[k - count];
      const d = r.d;
      return {
        file: r.f,
        id: d[0],
        session: d[1],
        prompt: d[2] === 1,
        len: d[3],
        kind: d[4],
        title: d[5],
        ts: d[6],
        weight: d[7],
        offset: -1,
        length: 0,
        shown: [d[8], d[9]],
      };
    }
    const f = lines[docsAt + k].split("\t");
    return {
      file: f[1],
      id: unesc(f[2]),
      session: unesc(f[3]),
      prompt: f[4] === "1",
      offset: Number(f[5]),
      length: Number(f[6]),
      len: Number(f[7]),
      kind: unesc(f[8]),
      title: unesc(f[9]),
      ts: Number(f[10]),
      weight: Number(f[11]),
    };
  };
  const byFile = new Map<string, number[]>();
  const push = (file: string, k: number) => {
    const list = byFile.get(file);
    if (list) list.push(k);
    else byFile.set(file, [k]);
  };
  for (let k = 0; k < count; k++) {
    const line = lines[docsAt + k];
    push(line.slice(2, line.indexOf("\t", 2)), k);
  }
  deltas.forEach((r, k) => push(r.f, count + k));

  const entries = new Map<Doc, Entry>();
  let total = 0;
  const cands: Candidate[] = [];
  for (const { file } of logs) {
    for (const k of byFile.get(file) || []) {
      const e = entryOf(k);
      if (!visible(e)) continue;
      total++;
      const tf = tfs.get(k);
      if (!tf) continue;
      const doc: Doc = {
        id: e.id,
        source: "obs",
        kind: e.kind,
        title: e.title,
        text: "",
        ts: e.ts,
        weight: e.weight,
      };
      entries.set(doc, e);
      cands.push({ doc, tf, len: e.len });
    }
  }

  const fill = (hits: Hit[]) => {
    for (const h of hits) {
      const e = entries.get(h.doc);
      if (!e) continue;
      const shown = e.shown ?? reread(project, e, toDoc);
      h.doc.display = shown[0];
      h.doc.text = shown[0];
      if (shown[1] !== null) h.doc.group = shown[1];
    }
    return hits;
  };
  return { total, cands, fill };
}

/** Display and group of a base entry, from its record in the log (verified unchanged by size). */
function reread(
  project: string,
  e: Entry,
  toDoc: (o: Observation) => Doc,
): [string, string | null] {
  const fd = openSync(join(observationDir(project), e.file), "r");
  try {
    const buf = Buffer.alloc(e.length);
    readSync(fd, buf, 0, e.length, e.offset);
    const doc = toDoc(JSON.parse(buf.toString("utf-8")));
    return [doc.display ?? "", doc.group ?? null];
  } finally {
    closeSync(fd);
  }
}
