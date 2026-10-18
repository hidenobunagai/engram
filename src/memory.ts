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
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
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
  /** Saved inside the team scope, so `share` may publish it. */
  team?: boolean;
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

/** Walks up to the nearest .git (file or dir) so subfolders of a repo share one project id. */
export function projectRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

export function projectId(cwd: string): string {
  const root = projectRoot(cwd);
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 8);
  const name = (basename(root) || "root").replace(/[^\w.-]/g, "_");
  return `${name}-${hash}`;
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const obsDir = (project: string) => join(dataDir(), "obs", project);
const notesFile = () => join(dataDir(), "notes.jsonl");
const recapFile = (project: string) => join(dataDir(), "recaps", `${project}.json`);

function safeName(session: string): string {
  return session.replace(/[^\w-]/g, "_");
}

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
    input: clip(sanitize(o.input), MAX_INPUT),
  };
  if (o.error) obs.error = clipMiddle(sanitize(o.error), MAX_ERROR);
  appendLine(join(obsDir(o.project), `${safeName(o.session)}.jsonl`), obs);
  return obs;
}

export function sessionObservations(project: string, session: string): Observation[] {
  return readLines<Observation>(join(obsDir(project), `${safeName(session)}.jsonl`));
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

/** Saving the same kind, title and body again refreshes the existing note instead of duplicating it. */
export function saveNote(n: Omit<Note, "t" | "id" | "ts"> & { id?: string }): Note {
  const title = clip(sanitize(n.title).replace(/\s+/g, " ").trim(), 200);
  const body = clip(sanitize(n.body), MAX_BODY);
  const same = n.id
    ? undefined
    : allNotes().find((x) => x.kind === n.kind && x.title === title && x.body === body);
  const note: Note = {
    t: "note",
    id: n.id || same?.id || newId(n.kind),
    ts: Date.now(),
    project: n.project,
    kind: n.kind,
    title,
    body,
  };
  if (n.session) note.session = n.session;
  if (n.tables?.length) note.tables = n.tables.map((t) => sanitize(t));
  if (n.tags?.length) note.tags = n.tags.map((t) => sanitize(t));
  if (n.team || same?.team) note.team = true;
  appendLine(notesFile(), note);
  return note;
}

/**
 * Removes every line of the note from disk, not just hides it.
 * ponytail: a note appended by a concurrent hook during the rewrite can be lost; the window is milliseconds.
 */
export function forget(id: string): boolean {
  if (!allNotes().some((n) => n.id === id)) return false;
  const file = notesFile();
  const kept = readLines<Note | Tombstone>(file).filter((r) => r.id !== id);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, kept.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf-8");
  renameSync(tmp, file);
  return true;
}

/** Latest version of each note, minus forgotten ones. */
export function allNotes(): Note[] {
  const byId = new Map<string, Note>();
  for (const r of readLines<Note | Tombstone>(notesFile())) {
    if (r.t === "del") byId.delete(r.id);
    else if (r.t === "note") byId.set(r.id, r);
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

export function readRecap(project: string): Recap | null {
  try {
    return JSON.parse(readFileSync(recapFile(project), "utf-8"));
  } catch {
    return null;
  }
}

/** Last writer wins; the recap only describes the most recent session. */
export function updateRecap(project: string, session: string, patch: Partial<Recap>): void {
  const prev = readRecap(project);
  const base: Recap = prev && prev.session === session ? prev : { session, project, ts: 0 };
  const next: Recap = { ...base, ...patch, session, project, ts: Date.now() };
  if (next.firstPrompt) next.firstPrompt = clip(sanitize(next.firstPrompt), 300);
  if (next.lastPrompt) next.lastPrompt = clip(sanitize(next.lastPrompt), 300);
  if (next.lastReply) next.lastReply = clip(sanitize(next.lastReply), MAX_REPLY);
  ensureDir(dirname(recapFile(project)));
  writeFileSync(recapFile(project), JSON.stringify(next), "utf-8");
}

/** Deletes observation files untouched for `days`. Notes are never pruned. */
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
        if (!f.endsWith(".jsonl") || (keepSession && f === `${safeName(keepSession)}.jsonl`))
          continue;
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
  return removed;
}
