import { createHash, randomUUID } from "crypto";
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
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, posix, resolve, win32 } from "path";
import { sanitize } from "./sanitizer";

export type Kind = "caveat" | "metric" | "query" | "decision" | "fact" | "fix" | "note";
export const KINDS: Kind[] = ["caveat", "metric", "query", "decision", "fact", "fix", "note"];

/** One tool call or prompt, captured automatically. Pruned after the retention period. */
export interface Observation {
  t: "obs";
  id: string;
  ts: number;
  session: string;
  project: string;
  tool: string;
  input: string;
  error?: string;
}

/** Durable knowledge: saved explicitly, or derived from an error followed by a working fix. */
export interface Note {
  t: "note";
  id: string;
  ts: number;
  session?: string;
  project: string;
  kind: Kind;
  title: string;
  body: string;
  tables?: string[];
  tags?: string[];
  /**
   * Observations this note was derived from. A fix carries the failed run it explains, so recall can
   * drop that raw observation once the fix is shown.
   */
  sources?: string[];
  /** Project root at save time; `share` re-checks the team scope against it. */
  root?: string;
  /**
   * `auto` for fixes engram paired itself, `user` for notes saved on purpose. Notes written before
   * this field existed are inferred by noteSource().
   */
  source?: NoteSource;
  /** First save; `ts` moves on every refresh. */
  created?: number;
  /** Recalled in every project, not only the one it was saved in. */
  global?: boolean;
}

export type NoteSource = "auto" | "user";

/** Pairing records the session; `engram save` never does. */
export function noteSource(n: Note): NoteSource {
  return n.source ?? (n.kind === "fix" && n.session ? "auto" : "user");
}

interface Tombstone {
  t: "del";
  id: string;
  ts: number;
}

export interface Recap {
  session: string;
  project: string;
  ts: number;
  firstPrompt?: string;
  lastPrompt?: string;
  lastReply?: string;
}

const MAX_INPUT = 2000;
const MAX_ERROR = 1000;
const MAX_BODY = 4000;
const MAX_REPLY = 800;

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const SQL_WORD = /\b(select|insert|update|delete|merge|create|alter|drop|grant|with|copy|from)\b/i;

/** How many delimiters a line carries, or 0. A data row is a row of the same table as its neighbours. */
const delimiters = (line: string): number => (line.match(/[,\t|;]/g) || []).length;

/**
 * Replaces a run of three or more data rows with `[N data rows omitted]`, keeping the line
 * above the run as the header. A heredoc body in a Bash command and a table pasted into a
 * prompt have the same shape, so one pass covers every path into storage. A run qualifies
 * when every row carries the same number of delimiters, which prose does not, and is left
 * alone when it opens with SQL.
 */
export function omitDataRows(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const width = delimiters(lines[i]);
    if (width < 2) {
      out.push(lines[i]);
      continue;
    }
    let end = i;
    while (end < lines.length && delimiters(lines[end]) === width) end++;
    const run = lines.slice(i, end);
    if (run.length < 3 || SQL_WORD.test(run.slice(0, 3).join(" "))) out.push(...run);
    else out.push(run[0], `[${run.length - 1} data rows omitted]`);
    i = end - 1;
  }
  return out.join("\n");
}

/** First sentence of a reply. A recap records what the session was about, not its results. */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const m = /^[\s\S]*?[.!?。](?=\s|$)/.exec(trimmed);
  return (m ? m[0] : trimmed).trim();
}

/** Keeps both ends: tracebacks put the actual error on the last line. */
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - (max - head))}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local-time "YYYY-MM-DD" and "YYYY-MM-DD HH:MM", so dates match what the analyst sees on their clock. */
export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function localTime(ts: number): string {
  const d = new Date(ts);
  return `${localDay(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** Personal memory lives outside any git clone and survives plugin reinstalls. */
export function dataDir(): string {
  return process.env.ENGRAM_HOME || join(homedir(), ".claude", "engram-memory");
}

/** A repository root: `.git` (a file in worktrees and submodules) or a `.jj` directory. */
const VCS_MARKERS = [".git", ".jj"];
/** Roots of work that is not (yet) in a repository: an analysis folder, a dbt or Python project. */
const FOLDER_MARKERS = [".engram", "dbt_project.yml", "pyproject.toml"];

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const hasMarker = (dir: string, m: string) =>
  m === ".git" || m === "dbt_project.yml" || m === "pyproject.toml"
    ? existsSync(join(dir, m))
    : isDir(join(dir, m));

/**
 * The folder whose subfolders share one project id. Walking up from cwd, the nearest repository root
 * (`.git`, `.jj`) wins; without one, the nearest folder holding `.engram/`, `dbt_project.yml` or
 * `pyproject.toml`. A marker inside a repository therefore never splits it (a dbt folder in a
 * monorepo stays part of the monorepo), and every git repository keeps the id it always had.
 * $HOME and anything above it never count: a dotfiles repository or a stray pyproject.toml in the
 * home folder would otherwise swallow every project under it. With no marker, cwd is the project.
 */
export function projectRoot(cwd: string, home: string = homedir()): string {
  const start = resolve(cwd);
  const homeKey = pathKey(home);
  let folder: string | undefined;
  for (let dir = start; pathKey(dir) !== homeKey;) {
    if (VCS_MARKERS.some((m) => hasMarker(dir, m))) return dir;
    if (!folder && FOLDER_MARKERS.some((m) => hasMarker(dir, m))) folder = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return folder ?? start;
}

/**
 * Canonical form of a path for ids and comparisons. Windows paths are case-insensitive and Claude Code
 * reports the same folder as both c:\\Users\\... and C:\\Users\\..., so they are lowercased with forward
 * slashes there. Other platforms keep the resolved path, so their ids stay unchanged.
 */
export function pathKey(p: string, platform: string = process.platform): string {
  const s = (platform === "win32" ? win32 : posix).resolve(p).replace(/\\/g, "/");
  const trimmed = s.length > 1 ? s.replace(/\/+$/, "") : s;
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

export function projectIdOfRoot(root: string, platform: string = process.platform): string {
  const key = pathKey(root, platform);
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
  const name = (posix.basename(key) || "root").replace(/[^\w.-]/g, "_");
  return `${name}-${hash}`;
}

export function projectId(cwd: string): string {
  return projectIdOfRoot(projectRoot(cwd));
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const obsDir = (project: string) => join(dataDir(), "obs", project);
/** Where a project's session logs live; the postings index reads them in this folder's order. */
export const observationDir = obsDir;
/** The postings index (postings.ts): derived from the observations, so deleting it loses nothing. */
export const indexRoot = () => join(dataDir(), "index");

/**
 * Drops every postings index. Rewrites that can keep a file's size (resanitize) and deletions are
 * not always visible to the index's freshness check, so they call this; the next search rebuilds.
 */
export function invalidateIndex(): void {
  rmSync(indexRoot(), { recursive: true, force: true });
}
const notesFile = () => join(dataDir(), "notes.jsonl");
const recapRoot = () => join(dataDir(), "recaps");
/** One recap per session, so parallel sessions in a project keep both. */
const recapFile = (project: string, session: string) =>
  join(recapRoot(), project, `${safeName(session)}.json`);
/** The single per-project recap of versions before 0.4, still read until a session replaces it. */
const legacyRecapFile = (project: string) => join(recapRoot(), `${project}.json`);
const errorLogFile = () => join(dataDir(), "error.log");

function safeName(session: string): string {
  return session.replace(/[^\w-]/g, "_");
}

/** The file name of a session's observation log inside observationDir(). */
export const sessionLogName = (session: string) => `${safeName(session)}.jsonl`;

/** One small appendFileSync per record: concurrent hooks append whole lines, never rewrite. */
function appendLine(file: string, record: object): void {
  ensureDir(dirname(file));
  appendFileSync(file, `${endsTorn(file) ? "\n" : ""}${JSON.stringify(record)}\n`, "utf-8");
}

/** True when a crashed writer left a partial last line, which the next record must not join. */
function endsTorn(file: string): boolean {
  try {
    const size = statSync(file).size;
    if (!size) return false;
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    closeSync(fd);
    return buf[0] !== 0x0a;
  } catch {
    return false;
  }
}

function readLines<T>(file: string, skip?: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line || (skip && line.includes(skip))) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn line from a crashed writer: skip it.
    }
  }
  return out;
}

export function saveObservation(o: Omit<Observation, "t" | "id" | "ts">): Observation {
  const obs: Observation = {
    t: "obs",
    id: newId("obs"),
    ts: Date.now(),
    session: o.session,
    project: o.project,
    tool: o.tool,
    input: clip(omitDataRows(sanitize(o.input)), MAX_INPUT),
  };
  if (o.error) obs.error = clipMiddle(sanitize(o.error), MAX_ERROR);
  appendLine(join(obsDir(o.project), `${safeName(o.session)}.jsonl`), obs);
  return obs;
}

export function sessionObservations(project: string, session: string): Observation[] {
  return readLines<Observation>(join(obsDir(project), `${safeName(session)}.jsonl`));
}

/**
 * Doc ids already shown in this session, one per line. The ledger is a sibling of the session's
 * observation log so a prompt never repeats a memory the session has already seen, and so pruning
 * removes it on the same schedule. It is never scanned as observations: the extension differs.
 */
const injectedFile = (project: string, session: string) =>
  join(obsDir(project), `${safeName(session)}.injected`);

export function injectedDocs(project: string, session: string): Set<string> {
  try {
    const text = readFileSync(injectedFile(project, session), "utf-8");
    return new Set(text.split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

export function markInjected(project: string, session: string, ids: string[]): void {
  if (!ids.length) return;
  const file = injectedFile(project, session);
  ensureDir(dirname(file));
  appendFileSync(file, `${endsTorn(file) ? "\n" : ""}${ids.join("\n")}\n`, "utf-8");
}

/** Forgets what the session was shown, e.g. after a compaction removed it from the context. */
export function clearInjected(project: string, session: string): void {
  try {
    unlinkSync(injectedFile(project, session));
  } catch {
    // Nothing recorded yet.
  }
}

/** `skipPrompts` drops prompt records before JSON.parse, which is most of the cost per prompt. */
export function projectObservations(
  project: string,
  opts: { skipPrompts?: boolean } = {},
): Observation[] {
  const dir = obsDir(project);
  if (!existsSync(dir)) return [];
  const skip = opts.skipPrompts ? '"tool":"prompt"' : undefined;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readLines<Observation>(join(dir, f), skip));
}

/** Every project's observations, for history --all. */
export function allObservations(): Observation[] {
  const root = join(dataDir(), "obs");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((p) => {
    try {
      return statSync(join(root, p)).isDirectory() ? projectObservations(p) : [];
    } catch {
      return [];
    }
  });
}

/** Saving the same note (project, kind, title, body) again refreshes it instead of duplicating it. */
export function saveNote(n: Omit<Note, "t" | "id" | "ts"> & { id?: string }): Note {
  const title = clip(sanitize(n.title).replace(/\s+/g, " ").trim(), 200);
  const body = clip(sanitize(n.body), MAX_BODY);
  const same = n.id
    ? undefined
    : allNotes().find(
        (x) => x.project === n.project && x.kind === n.kind && x.title === title && x.body === body,
      );
  const now = Date.now();
  const note: Note = {
    t: "note",
    id: n.id || same?.id || newId(n.kind),
    ts: now,
    project: n.project,
    kind: n.kind,
    title,
    body,
    source: n.source ?? "user",
    created: same?.created ?? same?.ts ?? now,
  };
  if (n.global || same?.global) note.global = true;
  if (n.session) note.session = n.session;
  if (n.tables?.length) note.tables = n.tables.map((t) => sanitize(t));
  if (n.tags?.length) note.tags = n.tags.map((t) => sanitize(t));
  // A refresh from another pairing keeps the observations the earlier ones were derived from.
  const sources = [...(same?.sources || []), ...(n.sources || [])];
  if (sources.length) note.sources = [...new Set(sources)];
  if (n.root) note.root = n.root;
  appendLine(notesFile(), note);
  // The same error paired again re-validates every automatic fix that names it.
  if (note.source === "auto")
    resetHits(
      allNotes()
        .filter(
          (x) =>
            x.project === note.project &&
            x.kind === note.kind &&
            x.title === note.title &&
            noteSource(x) === "auto",
        )
        .map((x) => x.id),
      now,
    );
  return note;
}

/** Removes every line of the note from disk, not just hides it. */
export function forget(id: string): boolean {
  if (!allNotes().some((n) => n.id === id)) return false;
  rewriteNotes(id);
  return true;
}

/**
 * Rewrites notes.jsonl with the latest line of each note, minus `drop`.
 * ponytail: a note appended by a concurrent hook during the rewrite can be lost; the window is milliseconds.
 */
function rewriteNotes(drop?: string): void {
  const latest = new Map<string, Note | Tombstone>();
  for (const r of readLines<Note | Tombstone>(notesFile())) {
    // Re-inserting keeps the order of last writes, which is the order allNotes() sees.
    latest.delete(r.id);
    if (r.t === "note" && r.id !== drop) latest.set(r.id, r);
  }
  writeAtomic(notesFile(), [...latest.values()].map((r) => `${JSON.stringify(r)}\n`).join(""));
}

/**
 * Every refresh of a note appends another line, and forget/purge leave nothing to read back, so
 * the file only grows. Rewrites it once superseded lines outnumber live notes, or whenever one
 * exists with `force` (after a purge, where an old version may still hold the purged text).
 */
export function compactNotes(force = false): boolean {
  const file = notesFile();
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean).length;
  const live = new Set(readLines<Note | Tombstone>(file).map((r) => r.id)).size;
  const dead = lines - live;
  if (!(force ? dead > 0 : dead > live)) return false;
  rewriteNotes();
  return true;
}

/** Latest version of each note, minus forgotten ones. */
export function allNotes(): Note[] {
  const byId = new Map<string, Note>();
  for (const r of readLines<Note | Tombstone>(notesFile())) {
    if (r.t === "del") byId.delete(r.id);
    // Notes that know their root re-derive the project, so ids from older key rules still match.
    else if (r.t === "note")
      byId.set(r.id, r.root ? { ...r, project: projectIdOfRoot(r.root) } : r);
  }
  return [...byId.values()];
}

export interface SessionSummary {
  project: string;
  session: string;
  start: number;
  end: number;
  records: number;
  errors: number;
  firstPrompt?: string;
}

/** One summary per session file, newest first. Without `project`, every project is listed. */
export function listSessions(project?: string): SessionSummary[] {
  const root = join(dataDir(), "obs");
  if (!existsSync(root)) return [];
  const out: SessionSummary[] = [];
  for (const p of project ? [project] : readdirSync(root)) {
    const dir = join(root, p);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const recs = readLines<Observation>(join(dir, f));
      if (!recs.length) continue;
      out.push({
        project: p,
        session: recs[0].session,
        start: recs[0].ts,
        end: recs[recs.length - 1].ts,
        records: recs.length,
        errors: recs.filter((r) => r.error).length,
        firstPrompt: recs.find((r) => r.tool === "prompt")?.input,
      });
    }
  }
  return out.sort((a, b) => b.end - a.end);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/** The newest recap of the project, leaving out `exceptSession` (the session asking). */
export function readRecap(project: string, exceptSession?: string): Recap | null {
  const dir = join(recapRoot(), project);
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(dir, f))
    : [];
  let best: Recap | null = null;
  for (const file of [...files, legacyRecapFile(project)]) {
    const r = readJson<Recap>(file);
    if (!r || typeof r.ts !== "number" || r.session === exceptSession) continue;
    if (!best || r.ts > best.ts) best = r;
  }
  return best;
}

/** Each session owns its recap file, written through a temp file so a reader never sees half of it. */
export function updateRecap(project: string, session: string, patch: Partial<Recap>): void {
  const file = recapFile(project, session);
  const prev = readJson<Recap>(file);
  const base: Recap = prev && prev.session === session ? prev : { session, project, ts: 0 };
  const next: Recap = { ...base, ...patch, session, project, ts: Date.now() };
  if (next.firstPrompt) next.firstPrompt = clip(omitDataRows(sanitize(next.firstPrompt)), 300);
  if (next.lastPrompt) next.lastPrompt = clip(omitDataRows(sanitize(next.lastPrompt)), 300);
  if (next.lastReply) next.lastReply = clip(sanitize(firstSentence(next.lastReply)), MAX_REPLY);
  ensureDir(dirname(file));
  writeAtomic(file, JSON.stringify(next));
}

/** Every recap file: one per session under recaps/<project>/, plus legacy recaps/<project>.json. */
function recapFiles(): string[] {
  const root = recapRoot();
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const f of readdirSync(root)) {
    const path = join(root, f);
    try {
      if (f.endsWith(".json")) out.push(path);
      else if (statSync(path).isDirectory())
        for (const g of readdirSync(path)) if (g.endsWith(".json")) out.push(join(path, g));
    } catch {
      // Vanished meanwhile.
    }
  }
  return out;
}

/**
 * Deletes recaps untouched for `days`, except the newest of each project: a project left alone
 * for months still opens with what happened last.
 */
function pruneRecaps(cutoff: number): number {
  const root = recapRoot();
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const project of readdirSync(root)) {
    try {
      const dir = join(root, project);
      if (!statSync(dir).isDirectory()) continue;
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const { file, mtime } of files.slice(1)) {
        if (mtime < cutoff) {
          unlinkSync(file);
          removed++;
        }
      }
    } catch {
      // Same as observations: a stray entry must not stop pruning.
    }
  }
  return removed;
}

/**
 * Deletes observation files and injection ledgers untouched for `days`, and old recaps (see
 * pruneRecaps). Notes are never pruned.
 */
export function pruneObservations(days: number, keepSession?: string): number {
  const root = join(dataDir(), "obs");
  if (!(days > 0) || !existsSync(root)) return 0;
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  for (const project of readdirSync(root)) {
    try {
      const dir = join(root, project);
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (!/\.(jsonl|injected)$/.test(f)) continue;
        if (keepSession && f.replace(/\.(jsonl|injected)$/, "") === safeName(keepSession)) continue;
        const file = join(dir, f);
        if (statSync(file).mtimeMs < cutoff) {
          unlinkSync(file);
          removed++;
        }
      }
    } catch {
      // A stray or vanished entry must not stop pruning (or the session start that runs it).
    }
  }
  if (removed) invalidateIndex();
  return removed + pruneRecaps(cutoff);
}

/** Text fields of a stored record, the places a secret or a data row can hide. */
const OBS_FIELDS = ["input", "error"] as const;
const NOTE_FIELDS = ["title", "body"] as const;
const RECAP_FIELDS = ["firstPrompt", "lastPrompt", "lastReply"] as const;

/** Per-store counts of what a rewrite touched. */
export interface RewriteReport {
  observations: number;
  notes: number;
  recaps: number;
}

/**
 * Rewrites every stored text field through `transform`, or drops the whole record when
 * `transform` returns null. Each store is read, filtered and written through a temp file, so
 * a crash mid-rewrite leaves the original intact. Returns how many records each store had
 * affected, which the caller reports.
 */
export function rewriteStores(
  transform: (
    text: string,
    record: { kind: "obs" | "note" | "recap"; id?: string },
  ) => string | null,
): RewriteReport {
  const report: RewriteReport = { observations: 0, notes: 0, recaps: 0 };
  const apply = (
    fields: readonly string[],
    record: Record<string, unknown>,
    kind: "obs" | "note" | "recap",
  ): { changed: boolean; drop: boolean } => {
    let changed = false;
    for (const field of fields) {
      const value = record[field];
      if (typeof value !== "string" || !value) continue;
      const next = transform(value, { kind, id: record.id as string | undefined });
      if (next === null) return { changed: true, drop: true };
      if (next !== value) {
        record[field] = next;
        changed = true;
      }
    }
    return { changed, drop: false };
  };
  const rewriteJsonl = (file: string, fields: readonly string[], kind: "obs" | "note"): void => {
    const records = readLines<Record<string, unknown>>(file);
    if (!records.length) return;
    let touched = 0;
    const kept: Record<string, unknown>[] = [];
    for (const record of records) {
      const { changed, drop } = apply(fields, record, kind);
      if (drop) touched++;
      else {
        if (changed) touched++;
        kept.push(record);
      }
    }
    if (!touched) return;
    writeAtomic(file, kept.map((r) => `${JSON.stringify(r)}\n`).join(""));
    report[kind === "obs" ? "observations" : "notes"] += touched;
  };

  const obsRoot = join(dataDir(), "obs");
  if (existsSync(obsRoot)) {
    for (const project of readdirSync(obsRoot)) {
      const dir = join(obsRoot, project);
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".jsonl")) rewriteJsonl(join(dir, f), OBS_FIELDS, "obs");
      }
    }
  }
  rewriteJsonl(notesFile(), NOTE_FIELDS, "note");

  if (report.observations) invalidateIndex();
  for (const file of recapFiles()) {
    try {
      const record = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
      const { changed, drop } = apply(RECAP_FIELDS, record, "recap");
      if (!changed) continue;
      // A purged recap goes as a whole, like an observation or a note.
      if (drop) unlinkSync(file);
      else writeAtomic(file, JSON.stringify(record));
      report.recaps++;
    } catch {
      // A recap that does not parse is left for the next session to overwrite.
    }
  }
  compactNotes(true);
  return report;
}

/** Writes beside the target and renames, so a reader never sees a half-written file. */
function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, file);
}

/** True when this project opted out of capture with a `.engram-ignore` file at its root. */
export function captureIgnored(cwd: string): boolean {
  return existsSync(join(projectRoot(cwd), ".engram-ignore"));
}

/** error.log stays below this size: older entries are dropped first. */
const ERROR_LOG_CAP = 256 * 1024;
const ENTRY_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /;

/**
 * Appends a hook failure, one entry per failure (a timestamp line, then the stack). Once the log
 * passes the cap, it is cut to its newest half at an entry boundary, through a temp file.
 */
export function logHookError(e: unknown): void {
  const file = errorLogFile();
  ensureDir(dirname(file));
  appendFileSync(file, `${new Date().toISOString()} ${(e as Error)?.stack || e}\n`, "utf-8");
  if (statSync(file).size <= ERROR_LOG_CAP) return;
  const lines = readFileSync(file, "utf-8").split("\n");
  let size = 0;
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += Buffer.byteLength(lines[i]) + 1;
    if (size > ERROR_LOG_CAP / 2) break;
    if (ENTRY_START.test(lines[i])) start = i;
  }
  writeAtomic(file, lines.slice(start).join("\n"));
}

export interface HookError {
  ts: number;
  /** The first line of the entry: the error message without its stack. */
  message: string;
}

/** Entries in error.log, oldest first. */
export function hookErrors(): HookError[] {
  let text: string;
  try {
    text = readFileSync(errorLogFile(), "utf-8");
  } catch {
    return [];
  }
  const out: HookError[] = [];
  for (const line of text.split("\n")) {
    if (!ENTRY_START.test(line)) continue;
    const at = line.indexOf(" ");
    out.push({ ts: Date.parse(line.slice(0, at)), message: line.slice(at + 1) });
  }
  return out;
}

/**
 * How often each note was injected, one line per event: `{id, ts}` for an injection, `{id, ts,
 * reset: true}` when the note was confirmed again (its error paired anew), and `{id, ts, n}` for
 * a compacted run of injections. Appending keeps concurrent hooks from losing each other's counts.
 */
const hitsFile = () => join(dataDir(), "hits.jsonl");

interface HitRecord {
  id: string;
  ts: number;
  n?: number;
  reset?: boolean;
}

export interface NoteUsage {
  /** Injections since the note was created or last confirmed. */
  hits: number;
  lastInjected?: number;
  /** Last time the note's error was paired again. */
  confirmed?: number;
}

export function recordHits(ids: string[], ts = Date.now()): void {
  if (!ids.length) return;
  const file = hitsFile();
  ensureDir(dirname(file));
  appendFileSync(
    file,
    `${endsTorn(file) ? "\n" : ""}${ids.map((id) => JSON.stringify({ id, ts })).join("\n")}\n`,
    "utf-8",
  );
}

function resetHits(ids: string[], ts: number): void {
  if (!ids.length) return;
  const file = hitsFile();
  ensureDir(dirname(file));
  appendFileSync(
    file,
    `${endsTorn(file) ? "\n" : ""}${ids.map((id) => JSON.stringify({ id, ts, reset: true })).join("\n")}\n`,
    "utf-8",
  );
}

export function noteUsage(): Map<string, NoteUsage> {
  const out = new Map<string, NoteUsage>();
  for (const r of readLines<HitRecord>(hitsFile())) {
    if (typeof r.id !== "string" || typeof r.ts !== "number") continue;
    const u = out.get(r.id) || { hits: 0 };
    if (r.reset) {
      u.hits = 0;
      u.confirmed = Math.max(u.confirmed ?? 0, r.ts);
    } else {
      u.hits += r.n ?? 1;
      u.lastInjected = Math.max(u.lastInjected ?? 0, r.ts);
    }
    out.set(r.id, u);
  }
  return out;
}

/**
 * Rewrites hits.jsonl as one or two lines per live note once it holds four times as many lines,
 * dropping notes that no longer exist.
 */
export function compactHits(): boolean {
  const file = hitsFile();
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean).length;
  const usage = noteUsage();
  if (lines <= Math.max(200, usage.size * 4)) return false;
  const live = new Set(allNotes().map((n) => n.id));
  const out: HitRecord[] = [];
  for (const [id, u] of usage) {
    if (!live.has(id)) continue;
    if (u.confirmed) out.push({ id, ts: u.confirmed, reset: true });
    if (u.lastInjected) out.push({ id, ts: u.lastInjected, n: u.hits });
  }
  writeAtomic(file, out.map((r) => `${JSON.stringify(r)}\n`).join(""));
  return true;
}

/** An automatic fix nobody was shown for this long is demoted. */
export const DECAY_IDLE_DAYS = 90;
/** An automatic fix shown this often without its error being paired again is demoted. */
export const DECAY_MAX_HITS = 10;

export type LifecycleState = "active" | "demoted";

export interface Lifecycle {
  state: LifecycleState;
  /** Why a note is demoted: `idle` (not shown for 90 days) or `unconfirmed` (shown 10+ times). */
  reason?: "idle" | "unconfirmed";
}

/**
 * Evaluated when read, from stored timestamps; nothing runs in the background. Only automatic fixes
 * decay: saved notes and team items stay active. A demoted fix is left out of injection but stays
 * searchable through recall and history, and pairing its error again makes it active.
 */
export function lifecycle(n: Note, usage?: NoteUsage, now = Date.now()): Lifecycle {
  if (noteSource(n) !== "auto") return { state: "active" };
  const confirmed = Math.max(n.ts, usage?.confirmed ?? 0);
  const seen = Math.max(confirmed, usage?.lastInjected ?? 0);
  if (now - seen > DECAY_IDLE_DAYS * 86_400_000) return { state: "demoted", reason: "idle" };
  if ((usage?.hits ?? 0) >= DECAY_MAX_HITS) return { state: "demoted", reason: "unconfirmed" };
  return { state: "active" };
}

/** The ids of notes left out of injection right now. */
export function demotedNotes(notes: Note[], now = Date.now()): Set<string> {
  const usage = noteUsage();
  return new Set(
    notes.filter((n) => lifecycle(n, usage.get(n.id), now).state === "demoted").map((n) => n.id),
  );
}
