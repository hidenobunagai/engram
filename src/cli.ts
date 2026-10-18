import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  type HookInput,
  buildDocs,
  onRefresh,
  onPrompt,
  onSessionStart,
  onStop,
  onToolUse,
  uniqueLines,
} from "./hooks";
import {
  type Kind,
  type Note,
  KINDS,
  allNotes,
  dataDir,
  forget,
  listSessions,
  localDay,
  localTime,
  projectId,
  projectObservations,
  projectRoot,
  saveNote,
} from "./memory";
import { search } from "./search";
import {
  loadTeam,
  projectStore,
  refreshSnapshot,
  serialize,
  setSelected,
  sharedStore,
  teamDirs,
  teamScope,
  writeTeamItem,
} from "./team";

const USAGE = `engram <command>
  recall <words...> [--limit N]        search personal memory and team knowledge
  save --kind K --title T [--tables a,b] [--tags x,y] [--body TEXT | stdin]
                                       kinds: ${KINDS.join(", ")}
  forget <note-id>                     erase a saved note
  share [<note-id>] [--yes] [--to DIR] list shareable notes, preview one, or publish it with --yes
  scope [on|off]                       show, select or unselect this project for team sharing
  history [--all] [--limit N]          list past sessions (this project, or all projects)
  history <session-id|YYYY-MM-DD>      show what happened in a session or on a day
  status                               show what is stored, loaded and in team scope
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
  else if (event === "refresh") onRefresh();
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
    root: projectRoot(process.cwd()),
  });
  const personal = teamScope(process.cwd()).inScope
    ? ""
    : " (personal only: outside the team scope)";
  return `Saved ${note.kind} ${note.id}: ${note.title}${personal}`;
}

/** The scope is checked now, against the project the note came from; notes without one stay personal. */
const shareable = (n: Note) => !!n.root && teamScope(n.root).inScope;

/** Without an id: the newest shareable notes that are not in the team store yet. */
function share(id: string | undefined, opt: Record<string, string>, yes: boolean): string {
  const { error } = refreshSnapshot(0);
  if (error) throw new Error(error);
  if (!id) {
    const shared = new Set(loadTeam(process.cwd()).items.map((t) => t.id));
    const candidates = allNotes()
      .filter((n) => !shared.has(n.id) && shareable(n))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 20);
    if (!candidates.length)
      return "No shareable notes. Notes saved inside the team scope appear here.";
    return [
      "Shareable notes (saved inside the team scope, not shared yet):",
      ...candidates.map((n) => `- ${n.id} [${n.kind} ${localDay(n.ts)}] ${n.title}`),
      "Share one with: engram share <note-id>",
    ].join("\n");
  }
  const note = allNotes().find((n) => n.id === id);
  if (!note) throw new Error(`No saved note with id "${id}". Find ids with: engram recall <words>`);
  if (!shareable(note)) {
    throw new Error(
      `${id} comes from a project outside the team scope (${note.root || "unknown project"}), so it stays personal. ` +
        "Run /engram:scope on in that project (or list it in the team's scope.json), then share it from there.",
    );
  }
  const base = opt.to || sharedStore() || projectStore(process.cwd());
  if (!base) {
    throw new Error(
      "No team folder configured. Set it with: claude plugin configure engram (team_dir), or pass --to DIR.",
    );
  }
  const item = {
    id: note.id,
    kind: note.kind,
    title: note.title,
    tables: note.tables || [],
    tags: note.tags || [],
    author: process.env.ENGRAM_AUTHOR,
    created_at: new Date(note.ts).toISOString().slice(0, 10),
    body: note.body,
  };
  // Writing to a shared folder publishes at once, so the default is a preview.
  if (!yes)
    return `Preview (nothing written yet) — would write to ${base}:\n\n${serialize(item)}\nRun again with --yes to publish it to the team.`;
  const path = writeTeamItem(base, item);
  refreshSnapshot(0);
  return `Wrote ${path}\nTeammates see it in their next session (a git-backed folder also needs a commit and push).`;
}

function history(pos: string[], opt: Record<string, string>): string {
  const project = projectId(process.cwd());
  const target = pos.find((p) => p !== "--all");
  if (!target) {
    const all = pos.includes("--all");
    const limit = Math.floor(Number(opt.limit));
    const sessions = listSessions(all ? undefined : project).slice(0, limit > 0 ? limit : 15);
    if (!sessions.length) return "No recorded sessions.";
    return [
      `Sessions${all ? "" : ` in ${project}`} (newest first):`,
      ...sessions.map(
        (s) =>
          `- ${s.session.slice(0, 8)} ${localTime(s.start)} → ${localTime(s.end).slice(11)} ` +
          `${s.records} records${s.errors ? `, ${s.errors} errors` : ""}${all ? ` [${s.project}]` : ""}` +
          (s.firstPrompt ? ` — ${s.firstPrompt.replace(/\s+/g, " ").slice(0, 100)}` : ""),
      ),
      "Show one with: engram history <session-id or YYYY-MM-DD>",
    ].join("\n");
  }
  const byDay = /^\d{4}-\d{2}-\d{2}$/.test(target);
  const recs = projectObservations(project)
    .filter((o) => (byDay ? localDay(o.ts) === target : o.session.startsWith(target)))
    .sort((a, b) => a.ts - b.ts)
    .slice(-200);
  if (!recs.length) return `Nothing recorded for "${target}" in ${project}.`;
  const ids = [...new Set(recs.map((o) => o.session))];
  if (!byDay && ids.length > 1)
    return [
      `"${target}" matches ${ids.length} sessions; use a longer prefix:`,
      ...ids.map((i) => `- ${i}`),
    ].join("\n");
  return [
    `Timeline for ${target} in ${project}:`,
    ...recs.map((o) => {
      const what = o.input.replace(/\s+/g, " ").slice(0, 160);
      const err = o.error ? ` ✗ ${o.error.replace(/\s+/g, " ").slice(0, 120)}` : "";
      return `- ${localTime(o.ts).slice(11)} ${byDay ? `${o.session.slice(0, 8)} ` : ""}${o.tool}: ${what}${err}`;
    }),
  ].join("\n");
}

function scope(action?: string): string {
  const cwd = process.cwd();
  if (action === "on" || action === "off") setSelected(cwd, action === "on");
  else if (action) throw new Error("Usage: engram scope [on|off]");
  refreshSnapshot(0);
  const s = teamScope(cwd);
  return `${projectRoot(cwd)}: ${s.inScope ? "in" : "out of"} team scope (${s.reason})`;
}

function status(): string {
  const cwd = process.cwd();
  const { snap, error } = refreshSnapshot(0);
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
    `- team scope: ${teamScope(cwd).inScope ? "in scope" : "out of scope"} (${teamScope(cwd).reason})`,
    `- team folder: ${sharedStore() || "none"}${error ? ` (${error})` : ""}`,
    `- team snapshot: ${snap ? `${snap.items.length} items, ${localTime(snap.at)}` : "none"}`,
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
    else if (cmd === "share")
      out = share(
        pos.find((p) => p !== "--yes"),
        opt,
        pos.includes("--yes"),
      );
    else if (cmd === "scope") out = scope(pos[0]);
    else if (cmd === "history") out = history(pos, opt);
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
