import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  type HookInput,
  buildDocs,
  onPrompt,
  onSessionStart,
  onStop,
  onToolUse,
  uniqueLines,
} from "./hooks";
import {
  type Kind,
  KINDS,
  allNotes,
  dataDir,
  forget,
  projectId,
  projectObservations,
  saveNote,
} from "./memory";
import { search } from "./search";
import { loadTeam, teamDirs, writeTeamItem } from "./team";

const USAGE = `engram <command>
  recall <words...> [--limit N]        search personal memory and team knowledge
  save --kind K --title T [--tables a,b] [--tags x,y] [--body TEXT | stdin]
                                       kinds: ${KINDS.join(", ")}
  forget <note-id>                     hide a saved note
  share <note-id> [--to DIR]           write a note as a team Markdown file
  status                               show what is stored and loaded
  hook <session-start|prompt|tool|stop>  used by hooks/hooks.json (reads JSON on stdin)`;

const OPTIONS = new Set(["kind", "title", "tables", "tags", "body", "limit", "to"]);

/** Known options always take the next token, so values like "-- top users" survive. */
function parse(argv: string[]): { pos: string[]; opt: Record<string, string> } {
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith("--") ? argv[i].slice(2) : "";
    if (OPTIONS.has(name)) opt[name] = argv[++i] ?? "";
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

const list = (v?: string) =>
  v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

function readStdin(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function logError(e: unknown): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(
      join(dataDir(), "error.log"),
      `${new Date().toISOString()} ${(e as Error)?.stack || e}\n`,
    );
  } catch {
    // Nowhere left to report; hooks must never break the session.
  }
}

function runHook(event: string): void {
  const raw = readStdin();
  const input = JSON.parse(raw) as HookInput;
  if (!input.cwd) input.cwd = process.cwd();
  let out = "";
  if (event === "session-start") out = onSessionStart(input);
  else if (event === "prompt") out = onPrompt(input);
  else if (event === "tool") onToolUse(input);
  else if (event === "stop") onStop(input);
  if (out) process.stdout.write(`${out}\n`);
}

function recall(words: string[], limit: number): string {
  const query = words.join(" ");
  if (!query.trim()) return "Usage: engram recall <words...>";
  const lines = uniqueLines(search(buildDocs(process.cwd()), query, limit * 4, 0), limit);
  if (!lines.length) return `No memory or team knowledge matches "${query}".`;
  return [`engram recall: "${query}"`, ...lines].join("\n");
}

function save(opt: Record<string, string>): string {
  const kind = (opt.kind || "note") as Kind;
  if (!KINDS.includes(kind)) throw new Error(`--kind must be one of: ${KINDS.join(", ")}`);
  if (!opt.title?.trim()) throw new Error("--title is required");
  const body = opt.body || (process.stdin.isTTY ? "" : readStdin());
  const note = saveNote({
    project: projectId(process.cwd()),
    kind,
    title: opt.title,
    body: body.trim() || opt.title,
    tables: list(opt.tables),
    tags: list(opt.tags),
  });
  return `Saved ${note.kind} ${note.id}: ${note.title}`;
}

function share(id: string | undefined, opt: Record<string, string>): string {
  const note = allNotes().find((n) => n.id === id);
  if (!note) throw new Error(`No saved note with id "${id}". Find ids with: engram recall <words>`);
  const base = opt.to || teamDirs(process.cwd())[0];
  if (!base) {
    throw new Error(
      "No team store found. Clone the team repo to ~/.claude/engram-team, create .engram/ in the project, or pass --to DIR.",
    );
  }
  const path = writeTeamItem(base, {
    id: note.id,
    kind: note.kind,
    title: note.title,
    tables: note.tables || [],
    tags: note.tags || [],
    author: process.env.ENGRAM_AUTHOR,
    created_at: new Date(note.ts).toISOString().slice(0, 10),
    body: note.body,
  });
  return `Wrote ${path}\nReview it, then commit and open a PR in that repository to share it with the team.`;
}

function status(): string {
  const cwd = process.cwd();
  const project = projectId(cwd);
  const notes = allNotes();
  const byKind = KINDS.map((k) => [k, notes.filter((n) => n.kind === k).length] as const).filter(
    ([, c]) => c,
  );
  const obs = projectObservations(project);
  const { items, skipped } = loadTeam(cwd);
  const lines = [
    `engram status`,
    `- data dir: ${dataDir()}`,
    `- project: ${project}`,
    `- saved notes: ${notes.length}${byKind.length ? ` (${byKind.map(([k, c]) => `${k} ${c}`).join(", ")})` : ""}`,
    `- captured observations for this project: ${obs.length} (errors: ${obs.filter((o) => o.error).length})`,
    `- team stores: ${teamDirs(cwd).join(", ") || "none"}`,
    `- team items loaded: ${items.length}`,
  ];
  for (const s of skipped) lines.push(`  - skipped ${s.path}: ${s.reason}`);
  return lines.join("\n");
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "hook") {
    try {
      runHook(rest[0]);
    } catch (e) {
      logError(e);
    }
    return;
  }
  const { pos, opt } = parse(rest);
  try {
    let out: string;
    if (cmd === "recall") out = recall(pos, Number(opt.limit) || 10);
    else if (cmd === "save") out = save(opt);
    else if (cmd === "forget")
      out = forget(pos[0] || "") ? `Forgot ${pos[0]}` : `No saved note with id "${pos[0]}"`;
    else if (cmd === "share") out = share(pos[0], opt);
    else if (cmd === "status") out = status();
    else out = USAGE;
    console.log(out);
  } catch (e) {
    console.error(`engram: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

if (Number(process.versions.node.split(".")[0]) < 18) {
  if (process.argv[2] !== "hook") console.error("engram needs Node.js 18 or newer.");
} else {
  main();
}
