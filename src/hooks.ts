import {
  type Note,
  type Observation,
  allNotes,
  clip,
  localDay as day,
  projectId,
  projectObservations,
  projectRoot,
  pruneObservations,
  readRecap,
  saveNote,
  saveObservation,
  sessionObservations,
  updateRecap,
} from "./memory";
import { type Doc, type Hit, search, tokenize } from "./search";
import { type TeamItem, loadTeam, summaryOf } from "./team";

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
const SESSION_BUDGET = 6000;

/** Read-only or navigation commands that would only add noise to memory. */
const TRIVIAL = new Set(
  "ls cd pwd cat head tail less more echo printf which whoami date clear true sleep wc file tree".split(
    " ",
  ),
);

const oneLine = (s: string, max: number) => clip(s.replace(/\s+/g, " ").trim(), max);

export function extractTables(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(
    /\b(?:from|join|into|update|table)\s+([`"[]?[\w$-]+(?:[`"\]]?\.[`"[]?[\w$-]+){0,2}[`"\]]?)/gi,
  )) {
    const name = m[1].replace(/[`"[\]]/g, "");
    if (!/^(select|with|lateral|unnest|the|a)$/i.test(name)) out.add(name);
  }
  return [...out];
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Files whose written text is analysis code worth remembering; other files are recorded by path only. */
const CODE_FILE = /\.(sql|py|r|ipynb|ya?ml|sh|jinja2?|j2|md|js|ts)$/i;

const SQL_WORD = /\b(select|insert|update|delete|merge|create|alter|drop|grant|with|copy|from)\b/i;

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
      if (typeof v === "string" && /^(sql|query|statement|command)$/i.test(k)) fields.push(v);
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

/** Trivial only if every segment of a chained command is trivial: `cd x && bq query ...` is kept. */
export function isTrivial(input: HookInput, text: string): boolean {
  if (input.tool_name !== "Bash") return false;
  if (/engram[\\/].*cli\.mjs|dist[\\/]cli\.mjs/.test(text)) return true;
  return text.split(/&&|\|\||[;|\n]/).every((seg) => {
    const s = seg.trim();
    return !s || TRIVIAL.has(firstWord(s)) || /^git\s+(status|diff|log|show|branch)\b/.test(s);
  });
}

function similar(a: Observation, b: Observation): boolean {
  if (a.tool !== b.tool) return false;
  if (a.tool === "Bash" && firstWord(a.input) === firstWord(b.input)) return true;
  const ta = new Set(tokenize(a.input));
  const tb = new Set(tokenize(b.input));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter / (ta.size + tb.size - inter || 1) >= 0.3;
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
    const errLine = errorHeadline(prev.error);
    return saveNote({
      project: success.project,
      session: success.session,
      kind: "fix",
      title: `Fix: ${oneLine(errLine, 120)}`,
      body: `Failed:\n\`\`\`\n${prev.input}\n\`\`\`\nError:\n\`\`\`\n${prev.error}\n\`\`\`\nWorked:\n\`\`\`\n${success.input}\n\`\`\``,
      tables: [...new Set([...extractTables(prev.input), ...extractTables(success.input)])],
      root,
    });
  }
  return null;
}

export function onToolUse(input: HookInput): void {
  if (process.env.ENGRAM_DISABLE_CAPTURE === "1" || !input.tool_name) return;
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
  if (!obs.error)
    detectFix(sessionObservations(project, input.session_id), obs, projectRoot(input.cwd));
}

export function onStop(input: HookInput): void {
  if (!input.last_assistant_message) return;
  updateRecap(projectId(input.cwd), input.session_id, { lastReply: input.last_assistant_message });
}

/**
 * Everything searchable for a project: team items, all notes, and this project's observations.
 * Prompt-time injection leaves out past prompts; the session-start recap already covers them.
 */
export function buildDocs(
  cwd: string,
  opts: { excludeSession?: string; prompts?: boolean } = {},
): Doc[] {
  const project = projectId(cwd);
  const docs: Doc[] = [];
  const team = loadTeam(cwd).items;
  const teamIds = new Set(team.map((t) => t.id));
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
      ref: t.path,
    });
  }
  for (const n of allNotes()) {
    // A shared note is already indexed through its team copy.
    if (teamIds.has(n.id)) continue;
    docs.push({
      id: n.id,
      source: "note",
      kind: n.kind,
      title: n.title,
      text: `${(n.tables || []).join(" ")} ${(n.tags || []).join(" ")} ${n.body}`,
      ts: n.ts,
      weight: n.project === project ? 1.3 : 1.1,
      display: n.kind === "fix" ? fixDisplay(n.body) : n.body,
    });
  }
  for (const o of projectObservations(project, { skipPrompts: opts.prompts === false })) {
    if (o.session === opts.excludeSession || (o.tool === "prompt" && opts.prompts === false))
      continue;
    docs.push({
      id: o.id,
      source: "obs",
      kind:
        o.tool === "prompt"
          ? "prompt"
          : o.error
            ? "error"
            : FILE_TOOLS.has(o.tool)
              ? "file"
              : "run",
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
    });
  }
  return docs;
}

/** For fixes, the working command is the part worth showing; the title already names the error. */
function fixDisplay(body: string): string {
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

/** Repeated runs of the same command collapse to one line. */
export function uniqueLines(hits: Hit[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    const key = h.doc.group ?? h.doc.display ?? h.doc.text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(formatHit(h));
    if (out.length === max) break;
  }
  return out;
}

function fitLines(header: string, lines: string[], budget: number): string {
  const out = [header];
  let size = header.length;
  for (const l of lines) {
    if (size + l.length + 1 > budget) break;
    out.push(l);
    size += l.length + 1;
  }
  return out.length > 1 ? out.join("\n") : "";
}

export function onPrompt(input: HookInput): string {
  const prompt = input.prompt || "";
  const project = projectId(input.cwd);
  let context = "";
  if (prompt.trim().length >= 4 && !prompt.trim().startsWith("/")) {
    const hits = search(
      buildDocs(input.cwd, { excludeSession: input.session_id, prompts: false }),
      prompt,
      20,
    );
    context = fitLines(
      "engram: records from earlier sessions and team knowledge that match this prompt (may be outdated; verify before relying on them):",
      uniqueLines(hits, 5),
      PROMPT_BUDGET,
    );
  }
  if (process.env.ENGRAM_DISABLE_CAPTURE !== "1" && prompt.trim()) {
    const saved = saveObservation({
      session: input.session_id,
      project,
      tool: "prompt",
      input: prompt,
    });
    // The session's own log, not the shared recap slot, knows its first prompt.
    const first = sessionObservations(project, input.session_id).find((o) => o.tool === "prompt");
    updateRecap(project, input.session_id, {
      firstPrompt: (first || saved).input,
      lastPrompt: prompt,
    });
  }
  return context;
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
    pruneObservations(RETENTION_DAYS, input.session_id);
  } catch {
    // Pruning is housekeeping; the recap and index below matter more.
  }
  const project = projectId(input.cwd);
  const parts: string[] = [];

  const recap = readRecap(project);
  if (recap && recap.session !== input.session_id && input.source !== "compact") {
    const lines = [`engram: previous session in this project (${day(recap.ts)}):`];
    if (recap.firstPrompt) lines.push(`- started with: ${oneLine(recap.firstPrompt, 200)}`);
    if (recap.lastPrompt && recap.lastPrompt !== recap.firstPrompt)
      lines.push(`- last request: ${oneLine(recap.lastPrompt, 200)}`);
    if (recap.lastReply) lines.push(`- last reply: ${oneLine(recap.lastReply, 400)}`);
    if (lines.length > 1) parts.push(lines.join("\n"));
  }

  const { items, skipped } = loadTeam(input.cwd);
  const index = teamIndex(items, skipped.length, SESSION_BUDGET - parts.join("\n").length - 300);
  if (index) parts.push(index);

  const notes = allNotes();
  const recent = notes
    .filter((n) => n.project === project)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5)
    .map((n) => `- [${n.kind} ${n.id}] ${oneLine(n.title, 140)}`);
  if (recent.length)
    parts.push(["engram: latest notes saved in this project:", ...recent].join("\n"));
  parts.push(
    `engram: personal memory holds ${notes.length} saved note(s); matching ones are added to prompts automatically. ` +
      "Durable findings (data caveats, metric definitions, fixes) can be saved with /engram:save; past sessions are listed by /engram:history.",
  );
  return parts.join("\n\n");
}
