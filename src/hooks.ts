import {
  type Note,
  type Observation,
  allNotes,
  captureIgnored,
  clearInjected,
  clip,
  compactHits,
  compactNotes,
  demotedNotes,
  indexRoot,
  injectedDocs,
  localDay as day,
  markInjected,
  projectId,
  projectObservations,
  projectRoot,
  pruneObservations,
  readRecap,
  recordHits,
  saveNote,
  saveObservation,
  sessionLogName,
  sessionObservations,
  updateRecap,
} from "./memory";
import { indexNeedsFold, indexObservation, indexedCandidates, rebuildIndex } from "./postings";
import {
  type Doc,
  type Hit,
  candidates,
  normalize,
  queryTerms,
  rank,
  search,
  tokenize,
} from "./search";
import {
  type TeamItem,
  loadTeam,
  persistPluginOption,
  refreshSnapshot,
  summaryOf,
  sharedStore,
  teamScope,
} from "./team";

/** Fields Claude Code sends on stdin (see tests/fixtures for real payloads). */
export interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  error?: string;
  last_assistant_message?: string;
}

const RETENTION_DAYS =
  Number(process.env.ENGRAM_RETENTION_DAYS) > 0 ? Number(process.env.ENGRAM_RETENTION_DAYS) : 90;
const PROMPT_BUDGET = 1500;
const PROMPT_ITEMS = 5;
/** Table matches go first, so they are capped to leave room for BM25 hits. */
const TABLE_ITEMS = 3;
/** Which kinds matter most when a table is about to be used. */
const KIND_ORDER = ["caveat", "fix", "metric", "query", "decision", "fact", "note"];
const kindRank = (kind: string) => {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
};
const SESSION_BUDGET = 6000;

/** Read-only or navigation commands that would only add noise to memory. */
const TRIVIAL = new Set(
  "ls cd pwd cat head tail less more echo printf which whoami date clear true sleep wc file tree".split(
    " ",
  ),
);

const oneLine = (s: string, max: number) => clip(s.replace(/\s+/g, " ").trim(), max);

const NAME = String.raw`[\`"[]?[\w$-]+(?:[\`"\]]?\.[\`"[]?[\w$-]+){0,2}[\`"\]]?`;
/** Words that can follow FROM/JOIN or a comma in a FROM list without being a table. */
const NOT_TABLE =
  /^(select|with|lateral|unnest|the|a|as|on|using|where|group|order|limit|having|union|join|left|right|inner|outer|full|cross|natural|window|qualify|values)$/i;
/**
 * A table reference, then any comma-separated ones (`FROM a x, b AS y`). FROM inside EXTRACT(...),
 * TRIM(...) and the like names a value, and `from x import y` is Python, so neither counts.
 */
const ALIAS = String.raw`(?:\s+(?:as\s+)?(?!(?:where|join|left|right|inner|outer|full|cross|natural|on|using|group|order|limit|having|union|window|qualify|import|select|from|lateral|set|values|and|or)\b)[\w$]+)?`;
const TABLE_REF = new RegExp(
  String.raw`(?<!\b(?:extract|trim|substring|position|overlay)\s*\([^()]*)\b(?:from|join|into|update|table)\s+(${NAME})(?![\w$.\x60"\]-])(?!\s+import\b)(${ALIAS}(?:\s*,\s*${NAME}${ALIAS})*)`,
  "gi",
);
/** Names a WITH clause defines (`WITH recent AS (`, `, totals AS (`): local to the query, not tables. */
const CTE = /(?:\bwith(?:\s+recursive)?|,)\s*([\w$]+)\s+as\s*(?:(?:not\s+)?materialized\s*)?\(/gi;

export function extractTables(sql: string): string[] {
  const local = new Set([...sql.matchAll(CTE)].map((m) => m[1].toLowerCase()));
  const out = new Set<string>();
  const add = (raw: string) => {
    const name = raw.replace(/[`"[\]]/g, "");
    if (!NOT_TABLE.test(name) && !local.has(name.toLowerCase())) out.add(name);
  };
  for (const m of sql.matchAll(TABLE_REF)) {
    add(m[1]);
    // The rest of a FROM list: each comma starts another table, optionally aliased.
    for (const c of m[2].matchAll(new RegExp(String.raw`,\s*(${NAME})`, "g"))) add(c[1]);
  }
  return [...out];
}

/**
 * Lowercased identifiers in free text or SQL, quotes stripped. A dotted name also contributes its
 * trailing parts, so `proj.analytics.dim_users` names `analytics.dim_users` and `dim_users`.
 */
export function identifiers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of normalize(text)
    .replace(/[`"[\]]/g, "")
    .match(/[a-z0-9_$][\w$.-]*/g) || []) {
    const parts = m.replace(/[.-]+$/, "").split(".");
    for (let i = 0; i < parts.length; i++) out.add(parts.slice(i).join("."));
  }
  return out;
}

/**
 * The tables among `tables` that `ids` name, by the whole name or a trailing dotted part of three
 * characters or more. Words inside a name do not count: `events` does not name `fct_events`.
 */
export function matchedTables(ids: Set<string>, tables: string[]): string[] {
  return tables.filter((t) => {
    const parts = normalize(t)
      .replace(/[`"[\]]/g, "")
      .split(".");
    return parts.some((_, i) => {
      const tail = parts.slice(i).join(".");
      return tail.length >= 3 && ids.has(tail);
    });
  });
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/**
 * Files whose written text is analysis code worth remembering; other files are recorded by
 * path only. `.md` is not here on purpose: a report Claude writes states findings, and its
 * prose is data rather than code.
 */
const CODE_FILE = /\.(sql|py|r|ipynb|ya?ml|sh|jinja2?|j2|js|ts)$/i;

const SQL_WORD = /\b(select|insert|update|delete|merge|create|alter|drop|grant|with|copy|from)\b/i;

/** A keyword used as a clause, not as a search prefix: `from:ceo` is Gmail, `from orders` is SQL. */
const SQL_ARG =
  /\b(?:select|insert|update|delete|merge|create|alter|drop|grant|with|copy)\b|\bfrom\b(?!\s*:)/i;

/** Rows of delimited data (an export saved under a code extension) rather than code. */
export function looksLikeData(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 3) return false;
  const delimited = lines.filter((l) => (l.match(/[,\t|;]/g) || []).length >= 3).length;
  return delimited / lines.length >= 0.8 && !SQL_WORD.test(lines.slice(0, 3).join(" "));
}

/** Code cells only: a written notebook's outputs can hold result tables and images. */
function notebookSource(content: string): string {
  try {
    const nb = JSON.parse(content) as {
      cells?: Array<{ cell_type?: string; source?: string | string[] }>;
    };
    return (nb.cells || [])
      .filter((c) => c.cell_type !== "raw")
      .map((c) => (Array.isArray(c.source) ? c.source.join("") : c.source || ""))
      .join("\n");
  } catch {
    return "";
  }
}

/**
 * "edit <path>" plus the new text for code files (Write content, Edit new_string, notebook source).
 * Data-looking text and SQL files without SQL are recorded by path only.
 */
function fileText(tool: string, ti: Record<string, unknown>): string | null {
  const path = typeof ti.file_path === "string" ? ti.file_path : ti.notebook_path;
  if (typeof path !== "string") return null;
  const head = `${tool.toLowerCase()} ${path}`;
  if (!CODE_FILE.test(path)) return head;
  const edits = Array.isArray(ti.edits)
    ? ti.edits.map((e) => (e as { new_string?: unknown }).new_string)
    : [];
  const content =
    typeof ti.content === "string" && /\.ipynb$/i.test(path)
      ? notebookSource(ti.content)
      : ti.content;
  const text = [content, ti.new_string, ti.new_source, ...edits]
    .filter((v) => typeof v === "string")
    .join("\n");
  if (!text || looksLikeData(text) || (/\.sql$/i.test(path) && !SQL_WORD.test(text))) return head;
  return `${head}\n${text}`;
}

/**
 * Write/Edit: see fileText. Bash: the command. MCP: only SQL-like string fields (sql, query, statement, command), never the
 * rest of the input, which can hold email bodies, sheet rows or document text. Other calls: nothing.
 */
export function toolText(input: HookInput): string | null {
  const ti = input.tool_input || {};
  if (input.tool_name === "Bash") return typeof ti.command === "string" ? ti.command : null;
  if (FILE_TOOLS.has(input.tool_name || "")) return fileText(input.tool_name!, ti);
  const fields: string[] = [];
  const visit = (obj: Record<string, unknown>, depth: number) => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && /^(sql|statement)$/i.test(k)) fields.push(v);
      // `query` and `command` also carry Gmail searches, Drive lookups and shell lines, so keep only SQL.
      else if (typeof v === "string" && /^(query|command)$/i.test(k) && SQL_ARG.test(v))
        fields.push(v);
      else if (depth < 1 && v && typeof v === "object" && !Array.isArray(v))
        visit(v as Record<string, unknown>, depth + 1);
    }
  };
  visit(ti, 0);
  return fields.length ? fields.join("\n") : null;
}

function firstWord(cmd: string): string {
  return (
    cmd
      .trim()
      .replace(/^(?:\w+=\S*\s+)+/, "")
      .split(/\s+/)[0] || ""
  );
}

const SEGMENT = /&&|\|\||[;|\n]/;

function trivialSegment(seg: string): boolean {
  const s = seg.trim();
  return !s || TRIVIAL.has(firstWord(s)) || /^git\s+(status|diff|log|show|branch)\b/.test(s);
}

/** Trivial only if every segment of a chained command is trivial: `cd x && bq query ...` is kept. */
export function isTrivial(input: HookInput, text: string): boolean {
  if (input.tool_name !== "Bash") return false;
  // engram's own commands, run directly or through the launcher the skills use.
  if (/engram[\\/].*cli\.mjs|dist[\\/]cli\.mjs|hooks[\\/]run-hook\.sh/.test(text)) return true;
  return text.split(SEGMENT).every(trivialSegment);
}

function runPart(o: Observation): string {
  if (o.tool !== "Bash") return o.input;
  const segs = o.input.split(SEGMENT);
  const first = segs.findIndex((s) => !trivialSegment(s));
  return first === -1 ? o.input : segs.slice(first).join(" ");
}

/** One shell word with its quotes removed; a word with any quoted part is always payload. */
interface Word {
  text: string;
  quoted: boolean;
}

/** One simple command of a shell line: its raw text, its words and the heredoc bodies it reads. */
interface ShellCommand {
  raw: string;
  words: Word[];
  bodies: string[];
}

/**
 * Splits a shell line into simple commands on `&&`, `||`, `;`, `|`, `&` and newlines outside quotes,
 * so a multi-line quoted SQL body stays one word. Heredoc bodies attach to the command being read
 * when their line ends; redirection operators separate words and are dropped.
 */
function shellCommands(cmd: string): ShellCommand[] {
  const cmds: ShellCommand[] = [];
  let cur: ShellCommand = { raw: "", words: [], bodies: [] };
  let start = 0;
  let word: Word | null = null;
  let delimNext = false;
  const delims: string[] = [];
  const endWord = () => {
    if (!word) return;
    if (delimNext) delims.push(word.text);
    else cur.words.push(word);
    delimNext = false;
    word = null;
  };
  const endCmd = (end: number, next: number) => {
    endWord();
    if (cur.words.length || cur.bodies.length) cmds.push({ ...cur, raw: cmd.slice(start, end) });
    cur = { raw: "", words: [], bodies: [] };
    start = next;
  };
  const add = (text: string, quoted: boolean) => {
    word ??= { text: "", quoted: false };
    word.text += text;
    word.quoted ||= quoted;
  };
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "'") {
      const j = cmd.indexOf("'", i + 1);
      const end = j === -1 ? cmd.length : j;
      add(cmd.slice(i + 1, end), true);
      i = end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') j += cmd[j] === "\\" ? 2 : 1;
      add(cmd.slice(i + 1, Math.min(j, cmd.length)), true);
      i = j + 1;
    } else if (ch === "\\") {
      // A backslash-newline continues the line; any other escaped character is literal.
      if (cmd[i + 1] !== "\n") add(cmd[i + 1] ?? "", false);
      i += 2;
    } else if (ch === "\n") {
      endWord();
      i++;
      for (const d of delims) {
        while (i < cmd.length) {
          const nl = cmd.indexOf("\n", i);
          const line = cmd.slice(i, nl === -1 ? cmd.length : nl);
          i = nl === -1 ? cmd.length : nl + 1;
          if (line.trim() === d) break;
          cur.bodies.push(line);
        }
      }
      delims.length = 0;
      endCmd(i, i);
    } else if (/\s/.test(ch)) {
      endWord();
      i++;
    } else if (cmd.startsWith("<<<", i)) {
      endWord();
      i += 3;
    } else if (cmd.startsWith("<<", i)) {
      endWord();
      i += cmd[i + 2] === "-" ? 3 : 2;
      delimNext = true;
    } else if (ch === "<" || ch === ">" || (ch === "&" && cmd[i + 1] === ">")) {
      // `2>&1`, `&>`, `>>`: the fd digits before are dropped by tokenize, the target stays a word.
      endWord();
      i++;
      while (cmd[i] === ">" || cmd[i] === "&") i++;
    } else if (ch === "&" || ch === "|" || ch === ";") {
      const next = i + (cmd[i + 1] === ch ? 2 : 1);
      endCmd(i, next);
      i = next;
    } else {
      add(ch, false);
      i++;
    }
  }
  endCmd(cmd.length, cmd.length);
  return cmds;
}

/** A program word, a subcommand word or a bare flag value: lowercase-style, no `. / _ = :`. */
const BARE = /^[a-z][a-z0-9-]*$/i;
const SHELLS = new Set("sh bash zsh dash ksh".split(" "));

/**
 * The payload words of one command. The invocation is dropped: leading `X=y` assignments, the
 * program word, the run of bare words after it (`uv run python`, `bq query`, `kubectl -n prod get`)
 * and every flag (`--x=y` keeps a non-bare `y`). A shell's `-c` string is scanned again, since
 * its own program and subcommands are invocation too.
 */
function payloadWords(c: ShellCommand): string[] {
  const out: string[] = [];
  let k = 0;
  while (k < c.words.length && !c.words[k].quoted && /^[A-Za-z_]\w*=/.test(c.words[k].text)) k++;
  const words = c.words.slice(k);
  let prefix = true;
  let shell = false;
  let inline = false;
  words.forEach((w, n) => {
    if (!w.quoted && w.text.startsWith("-")) {
      const value = w.text.slice(w.text.indexOf("=") + 1);
      if (w.text.includes("=") && value && !BARE.test(value)) out.push(value);
      if (shell && /^-[a-z]*c[a-z]*$/i.test(w.text)) inline = true;
      return;
    }
    if (inline) {
      inline = false;
      prefix = false;
      out.push(commandContent(w.text));
      return;
    }
    if (prefix && !w.quoted && (n === 0 || BARE.test(w.text))) {
      if (SHELLS.has(w.text.split("/").pop() || "")) shell = true;
      return;
    }
    prefix = false;
    out.push(w.text);
  });
  return [...out, ...c.bodies];
}

/**
 * The payload of a Bash command with its invocation words removed, after the same leading trivial
 * commands `runPart` skips. `bq query 'SELECT …'` gives the SQL, `python load.py --strict` gives
 * `load.py`, and an invocation-only command such as `bq ls analytics` gives nothing.
 */
export function commandContent(cmd: string): string {
  const cmds = shellCommands(cmd);
  const first = cmds.findIndex((c) => !trivialSegment(c.raw));
  return cmds
    .slice(first === -1 ? 0 : first)
    .flatMap(payloadWords)
    .filter(Boolean)
    .join("\n");
}

/** What pairing compares: a Bash command's payload, or the captured text of any other tool. */
function contentPart(o: Observation): string {
  return o.tool === "Bash" ? commandContent(o.input) : runPart(o);
}

/** Every token of the table names in `part`; two calls on one table are not therefore the same job. */
function tableTokens(part: string): Set<string> {
  const out = new Set<string>();
  for (const t of extractTables(part)) for (const k of tokenize(t)) out.add(k);
  return out;
}

const BLAMED = [
  /unrecognized name\s*:?\s*["'`]?([\w$.]+)/gi,
  /(?:no such column|unknown column|invalid column name)\s*:?\s*["'`]?([\w$.]+)/gi,
  /column\s+["'`]?([\w$.]+)["'`]?\s+(?:does not exist|not found|cannot be resolved)/gi,
];

/** Identifiers an error blames, e.g. `Unrecognized name: signup_dt` or `no such column: "signup_dt"`. */
export function blamedIdentifiers(error: string): string[] {
  return BLAMED.flatMap((re) => [...error.matchAll(re)].map((m) => m[1]));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when the failure and the success do the same job. Table names and the identifier the error
 * blamed carry no evidence of that: `SELECT signup_dt FROM dim_users` and `SELECT country, count(*)
 * FROM dim_users` share only the table, and the blamed column is what the fix was supposed to change.
 * Nor do a Bash command's invocation words: `bq query '<sql>'` twice shares only `bq query`, so only
 * the payloads are compared. An identical retry is still similar; detectFix then wants an edit.
 */
function similar(failed: Observation, worked: Observation): boolean {
  if (failed.tool !== worked.tool) return false;
  if (failed.tool === "Bash" && runPart(failed) === runPart(worked)) return true;
  const pf = contentPart(failed);
  const pw = contentPart(worked);
  const drop = tableTokens(pf);
  for (const t of tableTokens(pw)) drop.add(t);
  for (const id of blamedIdentifiers(failed.error || "")) drop.add(id.toLowerCase());
  const tf = new Set(tokenize(pf).filter((t) => !drop.has(t)));
  const tw = new Set(tokenize(pw).filter((t) => !drop.has(t)));
  const inter = [...tf].filter((t) => tw.has(t)).length;
  return inter / (tf.size + tw.size - inter || 1) >= 0.3;
}

/** False when the success still names an identifier the failure was told about: nothing was fixed. */
function blamedGone(failed: Observation, worked: Observation): boolean {
  const pw = runPart(worked);
  return blamedIdentifiers(failed.error || "").every((id) => {
    const name = id.split(".").pop() || id;
    if (!new RegExp(`\\b${escapeRe(name)}\\b`, "i").test(runPart(failed))) return true;
    return !new RegExp(`\\b${escapeRe(name)}\\b`, "i").test(pw);
  });
}

/** A file path an intervening Write/Edit touched, so an unchanged retry still names its real fix. */
function editedPath(history: Observation[]): string | null {
  for (const o of history) {
    if (!FILE_TOOLS.has(o.tool)) continue;
    const path = o.input.split("\n")[0].split(/\s+/).slice(1).join(" ");
    if (path) return path;
  }
  return null;
}

/** A headline that only carries an exit code or a pass/fail count says nothing about the cause. */
function noiseHeadline(line: string): boolean {
  const s = line.trim();
  return (
    /^exit code \d+$/i.test(s) ||
    /^\d+\s+(?:fail|fails|failed|failure|failures|error|errors)$/i.test(s)
  );
}

/** The most telling line of an error: the last line of a traceback, else the first real line. */
export function errorHeadline(error: string): string {
  const lines = error
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "…" && !/^exit code \d+$/i.test(l));
  if (!lines.length) return error.trim();
  return /traceback|^\s*at\s|stack trace/i.test(error) ? lines[lines.length - 1] : lines[0];
}

/**
 * An error followed by a similar successful call becomes a durable "fix" note.
 * An error that some earlier success already resolved is never paired again.
 */
export function detectFix(
  history: Observation[],
  success: Observation,
  root?: string,
): Note | null {
  if (FILE_TOOLS.has(success.tool)) return null;
  const isRun = (o: Observation) =>
    o.id !== success.id && o.tool !== "prompt" && !FILE_TOOLS.has(o.tool);
  for (let i = history.length - 1; i >= 0 && i >= history.length - 15; i--) {
    const prev = history[i];
    if (!isRun(prev) || !similar(prev, success)) continue;
    if (!prev.error) return null;
    if (history.slice(i + 1).some((o) => isRun(o) && !o.error && similar(o, prev))) return null;
    if (!blamedGone(prev, success)) return null;
    const errLine = errorHeadline(prev.error);
    if (noiseHeadline(errLine)) return null;
    // An unchanged retry proves nothing by itself, so an intervening edit has to carry the fix.
    const unchanged = runPart(prev) === runPart(success);
    const edited = unchanged ? editedPath(history.slice(i + 1)) : null;
    if (unchanged && !edited) return null;
    const body = [
      `Failed:\n\`\`\`\n${prev.input}\n\`\`\``,
      `Error:\n\`\`\`\n${prev.error}\n\`\`\``,
      edited ? `Edited:\n\`\`\`\n${edited}\n\`\`\`` : "",
      `Worked:\n\`\`\`\n${success.input}\n\`\`\``,
    ]
      .filter(Boolean)
      .join("\n");
    return saveNote({
      project: success.project,
      session: success.session,
      kind: "fix",
      title: edited ? `Fix: ${oneLine(errLine, 120)} (${edited})` : `Fix: ${oneLine(errLine, 120)}`,
      body,
      tables: [...new Set([...extractTables(prev.input), ...extractTables(success.input)])],
      // The fix shows both runs, so recall drops them as raw observations.
      sources: [prev.id, success.id],
      root,
      source: "auto",
    });
  }
  return null;
}

/** One gate for every capture path: the env switch, or a `.engram-ignore` at the project root. */
export function captureDisabled(cwd: string): boolean {
  return process.env.ENGRAM_DISABLE_CAPTURE === "1" || captureIgnored(cwd);
}

export function onToolUse(input: HookInput): void {
  if (captureDisabled(input.cwd) || !input.tool_name) return;
  const text = toolText(input);
  if (!text || isTrivial(input, text)) return;
  const project = projectId(input.cwd);
  const obs = saveObservation({
    session: input.session_id,
    project,
    tool: input.tool_name,
    input: text,
    error: input.hook_event_name === "PostToolUseFailure" ? input.error || "failed" : undefined,
  });
  indexCaptured(obs);
  if (!obs.error)
    detectFix(sessionObservations(project, input.session_id), obs, projectRoot(input.cwd));
}

export function onStop(input: HookInput): void {
  if (input.last_assistant_message && !captureDisabled(input.cwd))
    updateRecap(projectId(input.cwd), input.session_id, {
      lastReply: input.last_assistant_message,
    });
  onRefresh(input);
}

const SNAPSHOT_TTL = 10 * 60_000;

/**
 * Async only: the shared folder may be a slow or offline network drive, and an index rebuild reads
 * every session log of the project.
 */
export function onRefresh(input?: HookInput): void {
  try {
    persistPluginOption();
  } catch {
    // Keep the old setting; the refresh below still helps.
  }
  try {
    refreshSnapshot(SNAPSHOT_TTL);
  } finally {
    if (input?.cwd) maintainIndex(input.cwd);
  }
}

/** Notes of this project plus the ones saved as global: a client's caveat stays with its client. */
export const visibleIn = (project: string) => (n: Note) => n.project === project || !!n.global;

/** Filters that decide which docs a search sees. */
export interface DocOptions {
  excludeSession?: string;
  prompts?: boolean;
  allProjects?: boolean;
  injection?: boolean;
}

/**
 * Team items and this project's and global notes (every project's with `allProjects`). Prompt-time
 * injection (`injection`) leaves out demoted automatic fixes. Also returns the observations the
 * notes were derived from, which every search leaves out: the note already says what they would.
 */
export function memoryDocs(
  cwd: string,
  opts: DocOptions = {},
): { docs: Doc[]; derived: Set<string> } {
  const project = projectId(cwd);
  const docs: Doc[] = [];
  const team = loadTeam(cwd).items;
  const teamIds = new Set(team.map((t) => t.id));
  const notes = allNotes();
  const visible = opts.allProjects ? () => true : visibleIn(project);
  const demoted = opts.injection ? demotedNotes(notes) : new Set<string>();
  const derived = new Set(notes.flatMap((n) => n.sources || []));
  for (const t of team) {
    docs.push({
      id: t.id,
      source: "team",
      kind: t.kind,
      title: t.title,
      text: `${t.tables.join(" ")} ${t.tags.join(" ")} ${t.summary || ""} ${t.body}`,
      ts: Date.parse(t.created_at || "") || 0,
      weight: 1.5,
      display: summaryOf(t),
      tables: t.tables,
      ref: t.path,
    });
  }
  for (const n of notes) {
    // A shared note is already indexed through its team copy.
    if (teamIds.has(n.id) || !visible(n) || demoted.has(n.id)) continue;
    docs.push({
      id: n.id,
      source: "note",
      kind: n.kind,
      title: n.title,
      text: `${(n.tables || []).join(" ")} ${(n.tags || []).join(" ")} ${n.body}`,
      ts: n.ts,
      weight: n.project === project ? 1.3 : 1.1,
      display: n.kind === "fix" ? fixDisplay(n.body) : n.body,
      tables: n.tables,
    });
  }
  return { docs, derived };
}

/** How one observation is searched and shown. The postings index stores these fields. */
export function obsDoc(o: Observation): Doc {
  return {
    id: o.id,
    source: "obs",
    kind:
      o.tool === "prompt" ? "prompt" : o.error ? "error" : FILE_TOOLS.has(o.tool) ? "file" : "run",
    title: o.tool,
    text: `${o.input} ${o.error || ""}`,
    ts: o.ts,
    weight: o.error ? 1 : o.tool === "prompt" ? 0.5 : 0.6,
    display: o.error
      ? `error: ${oneLine(o.error, 160)} — from: ${oneLine(o.input, 120)}`
      : oneLine(o.input, 200),
    // Every edit of one file is one memory: recall shows its best-matching version only.
    group: FILE_TOOLS.has(o.tool)
      ? `file:${o.input.split("\n")[0].replace(/^\S+\s+/, "")}`
      : undefined,
  };
}

/** Whether a search under `opts` sees an observation; the index applies the same test. */
export const obsVisible =
  (opts: DocOptions, derived: Set<string>) =>
  (o: { id: string; session: string; prompt: boolean }) =>
    o.session !== opts.excludeSession &&
    !derived.has(o.id) &&
    !(o.prompt && opts.prompts === false);

/**
 * search() over memoryDocs() and the project's observations, with the observations from the
 * postings index when it is fresh. Same hits in the same order as search(buildDocs(...)); a stale,
 * missing or unreadable index falls back to that full scan and is rebuilt after the hook answered.
 * Also returns the memory docs, which the table channel looks through.
 */
export function recallSearch(
  cwd: string,
  query: string,
  opts: DocOptions,
  limit: number,
  minIdf = 3,
): { docs: Doc[]; hits: Hit[] } {
  const project = projectId(cwd);
  const { docs, derived } = memoryDocs(cwd, opts);
  const qTerms = queryTerms(query);
  let indexed: ReturnType<typeof indexedCandidates> = null;
  try {
    indexed = indexedCandidates(project, qTerms, obsVisible(opts, derived), obsDoc);
  } catch {
    // A damaged index answers like a missing one.
  }
  if (!indexed) {
    // Keyed by data dir too: the store is resolved again when the task runs.
    afterAnswer(`${indexRoot()}\0${project}`, () => rebuildIndex(project, obsDoc));
    return {
      docs,
      hits: search([...docs, ...scanObservations(project, opts, derived)], query, limit, minIdf),
    };
  }
  const cands = [...candidates(docs, qTerms), ...indexed.cands];
  return {
    docs,
    hits: indexed.fill(rank(docs.length + indexed.total, qTerms, cands, limit, minIdf)),
  };
}

/** Work a hook does after printing its answer, so a rebuild never delays a prompt. One per key. */
const deferred = new Map<string, () => void>();
const afterAnswer = (key: string, task: () => void) => {
  if (!deferred.has(key)) deferred.set(key, task);
};

/** Runs (and clears) the deferred work; any failure is swallowed like the hook's own. */
export function runDeferred(): void {
  const tasks = [...deferred.values()];
  deferred.clear();
  for (const task of tasks) {
    try {
      task();
    } catch {
      // The next search falls back to a full scan again.
    }
  }
}

/** Appends a fresh capture to the postings index; an index error only costs a later rebuild. */
function indexCaptured(o: Observation): void {
  try {
    indexObservation(o.project, o, obsDoc(o), sessionLogName(o.session));
  } catch {
    // The size check sees the missing delta and rebuilds.
  }
}

/** For async hooks: rebuild the index when it is stale, or fold a long delta into a new base. */
export function maintainIndex(cwd: string): void {
  const project = projectId(cwd);
  let fresh = false;
  try {
    fresh = indexedCandidates(project, [], () => true, obsDoc) !== null;
  } catch {
    // Damaged: rebuild.
  }
  if (!fresh || indexNeedsFold(project)) rebuildIndex(project, obsDoc);
}

function scanObservations(project: string, opts: DocOptions, derived: Set<string>): Doc[] {
  const visible = obsVisible(opts, derived);
  return projectObservations(project, { skipPrompts: opts.prompts === false })
    .filter((o) => visible({ id: o.id, session: o.session, prompt: o.tool === "prompt" }))
    .map(obsDoc);
}

/**
 * Everything searchable for a project by a full scan: memoryDocs() plus this project's observations.
 * Prompt-time injection leaves out past prompts; the session-start recap already covers them.
 */
export function buildDocs(cwd: string, opts: DocOptions = {}): Doc[] {
  const { docs, derived } = memoryDocs(cwd, opts);
  return [...docs, ...scanObservations(projectId(cwd), opts, derived)];
}

/** For fixes, the working command is the part worth showing; the title already names the error. */
export function fixDisplay(body: string): string {
  const worked = body.match(/Worked:\n```\n([\s\S]*?)\n```/);
  return worked ? `worked: ${worked[1]}` : body;
}

export function formatHit(h: Hit): string {
  const d = h.doc;
  const text = d.display ?? d.text;
  if (d.source === "team") return `- [team ${d.kind}] ${d.title}: ${oneLine(text, 160)} (${d.ref})`;
  if (d.source === "note")
    return `- [${d.kind} ${day(d.ts)} ${d.id}] ${d.title}: ${oneLine(text, 220)}`;
  return `- [past ${d.kind} ${day(d.ts)}] ${oneLine(text, 240)}`;
}

const lineKey = (d: Doc) => d.group ?? d.display ?? d.text;

/** Repeated runs of the same command collapse to one hit. */
export function uniqueHits(hits: Hit[], max: number): Hit[] {
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const h of hits) {
    const key = lineKey(h.doc);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length === max) break;
  }
  return out;
}

export function uniqueLines(hits: Hit[], max: number): string[] {
  return uniqueHits(hits, max).map(formatHit);
}

/** What the session ledger records for a doc: its group, so another edit of a shown file stays out too. */
const ledgerKey = (d: Doc) => d.group ?? d.id;

const bytes = (s: string) => Buffer.byteLength(s, "utf-8");

/**
 * The header plus as many lines as fit in `budget` UTF-8 bytes. Counting characters would let a
 * Japanese block reach three times the size.
 */
function fitLines(header: string, lines: string[], budget: number): string {
  const out = [header];
  let size = bytes(header);
  for (const l of lines) {
    if (size + bytes(l) + 1 > budget) break;
    out.push(l);
    size += bytes(l) + 1;
  }
  return out.length > 1 ? out.join("\n") : "";
}

export function onPrompt(input: HookInput): string {
  const prompt = input.prompt || "";
  const project = projectId(input.cwd);
  let context = "";
  if (prompt.trim().length >= 4 && !prompt.trim().startsWith("/")) {
    const shown = injectedDocs(project, input.session_id);
    const fresh = (d: Doc) => !shown.has(ledgerKey(d)) && !shown.has(d.id);
    const { docs, hits: ranked } = recallSearch(
      input.cwd,
      prompt,
      { excludeSession: input.session_id, prompts: false, injection: true },
      20,
    );
    // A note on a table the prompt names is relevant however common the table's name is in the
    // corpus, where BM25 gives it next to no weight.
    const ids = identifiers(prompt);
    const byTable = docs
      .filter((d) => d.tables?.length && fresh(d) && matchedTables(ids, d.tables).length)
      .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || b.weight - a.weight || b.ts - a.ts)
      .slice(0, TABLE_ITEMS)
      .map((doc) => ({ doc, score: 0 }));
    const tableIds = new Set(byTable.map((h) => h.doc.id));
    const hits = [...byTable, ...ranked.filter((h) => fresh(h.doc) && !tableIds.has(h.doc.id))];
    const picked = uniqueHits(hits, PROMPT_ITEMS);
    context = fitLines(
      "engram: records from earlier sessions and team knowledge that match this prompt (may be outdated; verify before relying on them):",
      picked.map(formatHit),
      PROMPT_BUDGET,
    );
    // Only lines that fit the budget were shown. Every hit that collapsed into a shown line
    // (another run of the same command) counts as shown too.
    const shownHits = picked.slice(0, context ? context.split("\n").length - 1 : 0);
    const keys = new Set(shownHits.map((h) => lineKey(h.doc)));
    if (keys.size && !captureDisabled(input.cwd)) {
      markInjected(project, input.session_id, [
        ...new Set(hits.filter((h) => keys.has(lineKey(h.doc))).map((h) => ledgerKey(h.doc))),
      ]);
      recordHits(shownHits.filter((h) => h.doc.source === "note").map((h) => h.doc.id));
    }
  }
  if (!captureDisabled(input.cwd) && prompt.trim()) {
    const saved = saveObservation({
      session: input.session_id,
      project,
      tool: "prompt",
      input: prompt,
    });
    indexCaptured(saved);
    // The session's own log, not the shared recap slot, knows its first prompt.
    const first = sessionObservations(project, input.session_id).find((o) => o.tool === "prompt");
    updateRecap(project, input.session_id, {
      firstPrompt: (first || saved).input,
      lastPrompt: prompt,
    });
  }
  return context;
}

const GUARD_ITEMS = 3;
const GUARD_BUDGET = 1200;

/** Columns a fix's error blamed (`signup_dt`), lowercased and without their table prefix. */
function blamedInFix(body: string): string[] {
  const error = body.match(/Error:\n```\n([\s\S]*?)\n```/);
  return error
    ? blamedIdentifiers(error[1]).map((id) => (id.split(".").pop() || id).toLowerCase())
    : [];
}

interface Warning {
  id: string;
  kind: string;
  line: string;
  /** Known-bad columns the query is about to use again. */
  bad: string[];
  own: boolean;
  ts: number;
}

/**
 * PreToolUse for Bash and MCP calls: caveats and fixes on the tables a query is about to touch,
 * returned as additionalContext before it runs. Reads notes.jsonl and the team snapshot only,
 * never observations, and returns before reading anything when the call carries no SQL.
 */
export function onPreToolUse(input: HookInput): string {
  const tool = input.tool_name || "";
  if (tool !== "Bash" && !tool.startsWith("mcp__")) return "";
  const sql = toolText(input);
  if (!sql || !SQL_ARG.test(sql)) return "";
  const tables = extractTables(sql);
  if (!tables.length) return "";
  const named = identifiers(tables.join(" "));
  const words = identifiers(sql);
  const project = projectId(input.cwd);
  const shown = injectedDocs(project, input.session_id);

  const found = new Map<string, Warning>();
  const consider = (
    w: Omit<Warning, "bad" | "line"> & { tables: string[]; body: string; line: string },
  ) => {
    if ((w.kind !== "caveat" && w.kind !== "fix") || found.has(w.id)) return;
    if (!matchedTables(named, w.tables).length) return;
    let bad: string[] = [];
    if (w.kind === "fix") {
      const blamed = blamedInFix(w.body);
      bad = blamed.filter((c) => words.has(c));
      // The query already avoids the column this fix is about.
      if (blamed.length && !bad.length) return;
    }
    // Shown earlier in the session, unless the query repeats the mistake.
    if (shown.has(w.id) && !bad.length) return;
    const line = bad.length ? `${w.line} — this query uses ${bad.join(", ")} again` : w.line;
    found.set(w.id, { id: w.id, kind: w.kind, line, bad, own: w.own, ts: w.ts });
  };
  for (const t of loadTeam(input.cwd).items)
    consider({
      id: t.id,
      kind: t.kind,
      tables: t.tables,
      body: t.body,
      own: true,
      ts: Date.parse(t.created_at || "") || 0,
      line: `- [team ${t.kind}] ${t.title}: ${oneLine(summaryOf(t), 160)} (${t.path})`,
    });
  const notes = allNotes().filter(visibleIn(project));
  const demoted = demotedNotes(notes);
  for (const n of notes.filter((n) => !demoted.has(n.id)))
    consider({
      id: n.id,
      kind: n.kind,
      tables: n.tables || [],
      body: n.body,
      own: n.project === project,
      ts: n.ts,
      line: `- [${n.kind} ${day(n.ts)} ${n.id}] ${n.title}: ${oneLine(n.kind === "fix" ? fixDisplay(n.body) : n.body, 220)}`,
    });

  const picked = [...found.values()]
    .sort(
      (a, b) =>
        Number(!a.bad.length) - Number(!b.bad.length) ||
        kindRank(a.kind) - kindRank(b.kind) ||
        Number(b.own) - Number(a.own) ||
        b.ts - a.ts,
    )
    .slice(0, GUARD_ITEMS);
  const context = fitLines(
    `engram: known issues with ${tables.join(", ")} from memory, before this query runs (may be outdated; verify):`,
    picked.map((w) => w.line),
    GUARD_BUDGET,
  );
  if (!context) return "";
  if (!captureDisabled(input.cwd))
    try {
      const ids = picked.slice(0, context.split("\n").length - 1).map((w) => w.id);
      markInjected(project, input.session_id, ids);
      const noteIds = new Set(notes.map((n) => n.id));
      recordHits(ids.filter((id) => noteIds.has(id)));
    } catch {
      // The warning matters more than remembering it was given.
    }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context },
  });
}

const COMPACT_FIXES = 5;
const COMPACT_ERRORS = 3;
const COMPACT_BUDGET = 2000;

/**
 * The session's own fixes and latest errors. A compaction drops them from the context, and
 * prompt-time recall leaves the current session's observations out, so nothing else brings them back.
 */
function compactRecall(project: string, session: string, fixes: Note[]): string {
  const told = new Set(fixes.flatMap((n) => n.sources || []));
  const errors = sessionObservations(project, session)
    .filter((o) => o.error && !told.has(o.id))
    .slice(-COMPACT_ERRORS);
  return fitLines(
    "engram: found earlier in this session, before the context was compacted:",
    [
      ...fixes.map(
        (n) => `- [fix ${n.id}] ${oneLine(n.title, 140)}: ${oneLine(fixDisplay(n.body), 220)}`,
      ),
      ...errors.map(
        (o) =>
          `- [error ${day(o.ts)}] ${oneLine(errorHeadline(o.error!), 160)} — from: ${oneLine(o.input, 120)}`,
      ),
    ],
    COMPACT_BUDGET,
  );
}

function teamIndex(items: TeamItem[], skipped: number, budget: number): string {
  if (!items.length && !skipped) return "";
  const order = ["caveat", "metric", "fix", "query", "decision", "fact", "note"];
  const sorted = [...items].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const lines = sorted.map((t) => {
    const tables = t.tables.length ? ` [${t.tables.join(", ")}]` : "";
    const summary = summaryOf(t);
    return `- ${t.kind}: ${t.title}${tables}${summary ? ` — ${oneLine(summary, 140)}` : ""} (${t.path})`;
  });
  const out = [
    fitLines(
      `engram team knowledge (${items.length} items). Full details are in the listed files:`,
      lines,
      budget,
    ),
  ].filter(Boolean);
  const shown = out.length ? out[0].split("\n").length - 1 : 0;
  if (shown < items.length)
    out.push(
      `engram: ${items.length - shown} more team item(s) not listed; search them with /engram:recall <words>`,
    );
  if (skipped)
    out.push(
      `engram: ${skipped} team file(s) skipped because of invalid frontmatter; run /engram:status for details`,
    );
  return out.join("\n");
}

export function onSessionStart(input: HookInput): string {
  try {
    persistPluginOption();
  } catch {
    // A read-only data dir must not cost the recap and index below.
  }
  try {
    pruneObservations(RETENTION_DAYS, input.session_id);
    compactNotes();
    compactHits();
  } catch {
    // Pruning is housekeeping; the recap and index below matter more.
  }
  const project = projectId(input.cwd);
  const parts: string[] = [];
  const notes = allNotes();

  const sessionFixes =
    input.source === "compact"
      ? notes
          .filter((n) => n.kind === "fix" && n.session === input.session_id)
          .sort((a, b) => a.ts - b.ts)
          .slice(-COMPACT_FIXES)
      : [];
  if (input.source === "compact") {
    // What earlier prompts were shown left the context with the compaction, so they may show again.
    clearInjected(project, input.session_id);
    const recalled = compactRecall(project, input.session_id, sessionFixes);
    if (recalled) parts.push(recalled);
  }

  const recap = input.source === "compact" ? null : readRecap(project, input.session_id);
  if (recap) {
    const lines = [`engram: previous session in this project (${day(recap.ts)}):`];
    if (recap.firstPrompt) lines.push(`- started with: ${oneLine(recap.firstPrompt, 200)}`);
    if (recap.lastPrompt && recap.lastPrompt !== recap.firstPrompt)
      lines.push(`- last request: ${oneLine(recap.lastPrompt, 200)}`);
    if (recap.lastReply) lines.push(`- last reply: ${oneLine(recap.lastReply, 400)}`);
    if (lines.length > 1) parts.push(lines.join("\n"));
  }

  const { items, skipped } = loadTeam(input.cwd);
  if (sharedStore() && !teamScope(input.cwd).inScope)
    parts.push(
      "engram: a team folder is set, but this project is not selected, so it stays personal. /engram:scope on includes it.",
    );
  const index = teamIndex(items, skipped.length, SESSION_BUDGET - bytes(parts.join("\n")) - 300);
  if (index) parts.push(index);

  const own = notes.filter((n) => n.project === project);
  const recalled = new Set(sessionFixes.map((n) => n.id));
  const demoted = demotedNotes(own);
  const recent = own
    .filter((n) => !recalled.has(n.id) && !demoted.has(n.id))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5)
    .map((n) => `- [${n.kind} ${n.id}] ${oneLine(n.title, 140)}`);
  if (recent.length)
    parts.push(["engram: latest notes saved in this project:", ...recent].join("\n"));
  // Count this project separately: saying "this project holds 7" while listing one reads as a bug.
  // Global notes from elsewhere reach prompts here too; the rest only an explicit recall --all.
  const global = notes.filter((n) => n.project !== project && n.global).length;
  const elsewhere = notes.length - own.length - global;
  parts.push(
    `engram: personal memory holds ${own.length} saved note(s) for this project` +
      (global ? `, plus ${global} global` : "") +
      "; matching ones are added to prompts automatically" +
      (elsewhere
        ? ` (${elsewhere} from other projects stay there; search them with /engram:recall --all)`
        : "") +
      ". " +
      "Durable findings (data caveats, metric definitions, fixes) can be saved with /engram:save; past sessions are listed by /engram:history.",
  );
  return parts.join("\n\n");
}
