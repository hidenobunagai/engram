import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import {
  type HookInput,
  errorHeadline,
  extractTables,
  fixDisplay,
  identifiers,
  matchedTables,
  onRefresh,
  onPreToolUse,
  onPrompt,
  onSessionStart,
  onStop,
  onToolUse,
  recallSearch,
  runDeferred,
  uniqueLines,
  visibleIn,
} from "./hooks";
import {
  type Kind,
  type Note,
  DECAY_IDLE_DAYS,
  DECAY_MAX_HITS,
  KINDS,
  allNotes,
  allObservations,
  captureIgnored,
  clip,
  dataDir,
  forget,
  hookErrors,
  lifecycle,
  listSessions,
  logHookError,
  noteSource,
  noteUsage,
  localDay,
  localTime,
  projectId,
  projectObservations,
  projectRoot,
  rewriteStores,
  saveNote,
} from "./memory";
import { sanitize } from "./sanitizer";
import {
  loadTeam,
  planTeamWrite,
  samePath,
  projectStore,
  refreshSnapshot,
  setSelected,
  sharedStore,
  summaryOf,
  teamDirs,
  teamScope,
  writeTeamItem,
} from "./team";

const USAGE = `engram <command>
  recall <words...> [--limit N] [--all]
                                       search this project's and global notes, its past
                                       sessions and team knowledge (--all: notes of every project)
  save --kind K --title T [--tables a,b] [--tags x,y] [--global] [--body TEXT | stdin]
                                       kinds: ${KINDS.join(", ")}
                                       --global: recalled in every project, not only this one
  forget <note-id>                     erase a saved note
  purge <regex|obs-id>                 delete stored observations, notes and recaps that match,
                                       or one observation by id; counts each store
  resanitize                           re-apply the current redaction rules to everything stored
  share [<note-id>] [--yes [--update]] [--to DIR]
                                       list shareable notes, preview one, or publish it with --yes
                                       (--update replaces a team file that differs)
  scope [on|off]                       show, select or unselect this project for team sharing
  history [--all] [--limit N]          list past sessions (this project, or all projects)
  history <session-id|YYYY-MM-DD> [--all]
                                       show what happened in a session or on a day
                                       (this project, or all projects)
  status                               show what is stored, loaded and in team scope
  table <name>                         what engram knows about one table: notes, common
                                       errors, the fixes that resolved them, last use
  stats                                disk use, records by kind and source, top tables
  hook <session-start|prompt|pre-tool|tool|stop|refresh>
                                       used by hooks/hooks.json (reads JSON on stdin)`;

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
    logHookError(e);
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
  else if (event === "pre-tool") out = onPreToolUse(input);
  else if (event === "stop") onStop(input);
  else if (event === "refresh") onRefresh(input);
  if (out) process.stdout.write(`${out}\n`);
  runDeferred();
}

function recall(words: string[], limit: number): string {
  const allProjects = words.includes("--all");
  const query = words.filter((w) => w !== "--all").join(" ");
  if (!query.trim()) return "Usage: engram recall <words...> [--all]";
  const { hits } = recallSearch(process.cwd(), query, { allProjects }, limit * 4, 0);
  const lines = uniqueLines(hits, limit);
  if (!lines.length) return `No memory or team knowledge matches "${query}".`;
  return [`engram recall: "${query}"`, ...lines].join("\n");
}

function save(opt: Record<string, string>, global: boolean): string {
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
    source: "user",
    global,
  });
  const personal = teamScope(process.cwd()).inScope
    ? ""
    : " (personal only: outside the team scope)";
  const where = note.global ? " (global: recalled in every project)" : "";
  return `Saved ${note.kind} ${note.id}: ${note.title}${where}${personal}`;
}

/** The scope is checked now, against the project the note came from; notes without one stay personal. */
const shareable = (n: Note) => !!n.root && teamScope(n.root).inScope;

/** Without an id: the newest shareable notes that are not in the team store yet. */
function share(
  id: string | undefined,
  opt: Record<string, string>,
  yes: boolean,
  update = false,
): string {
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
  const local = projectStore(process.cwd());
  const base = opt.to || sharedStore() || local;
  if (!base) {
    throw new Error(
      "No team folder configured. Set it with: claude plugin configure engram (team_dir), or pass --to DIR.",
    );
  }
  // A project's .engram/ only takes that project's own notes; it is usually committed with the repo.
  if (base === local && !opt.to && !samePath(note.root || "", projectRoot(process.cwd())))
    throw new Error(`${id} comes from ${note.root}; share it from that project, or pass --to DIR.`);
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
  const plan = planTeamWrite(base, item);
  const changed = plan.existing !== undefined && plan.existing !== plan.text;
  // Writing to a shared folder publishes at once, so the default is a preview.
  if (!yes) {
    const action =
      plan.existing === undefined
        ? `write ${plan.path}`
        : changed
          ? `REPLACE ${plan.path} (it differs from this note; a teammate may have edited it)`
          : `leave ${plan.path} unchanged`;
    return `Preview (nothing written yet) — would ${action}:\n\n${plan.text}\nRun again with --yes to publish it to the team${changed ? " (add --update to replace the existing file)" : ""}.`;
  }
  if (changed && !update)
    throw new Error(
      `${plan.path} already exists with different content. Check it, then run again with --yes --update to replace it.`,
    );
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
  const all = pos.includes("--all");
  const where = all ? "all projects" : project;
  const recs = (all ? allObservations() : projectObservations(project))
    .filter((o) => (byDay ? localDay(o.ts) === target : o.session.startsWith(target)))
    .sort((a, b) => a.ts - b.ts)
    .slice(-200);
  if (!recs.length) return `Nothing recorded for "${target}" in ${where}.`;
  const ids = [...new Set(recs.map((o) => o.session))];
  if (!byDay && ids.length > 1)
    return [
      `"${target}" matches ${ids.length} sessions; use a longer prefix:`,
      ...ids.map((i) => `- ${i}`),
    ].join("\n");
  return [
    `Timeline for ${target} in ${where}:`,
    ...recs.map((o) => {
      const what = o.input.replace(/\s+/g, " ").slice(0, 160);
      const err = o.error ? ` ✗ ${o.error.replace(/\s+/g, " ").slice(0, 120)}` : "";
      const tag = all ? ` [${o.project}]` : "";
      return `- ${localTime(o.ts).slice(11)} ${byDay ? `${o.session.slice(0, 8)} ` : ""}${o.tool}${tag}: ${what}${err}`;
    }),
  ].join("\n");
}

function scope(action?: string): string {
  const cwd = process.cwd();
  if (action === "on" || action === "off") setSelected(cwd, action === "on");
  else if (action) throw new Error("Usage: engram scope [on|off]");
  const { error } = refreshSnapshot(0);
  const s = teamScope(cwd);
  const note = error ? `\nWarning: ${error}; using the last snapshot.` : "";
  return `${projectRoot(cwd)}: ${s.inScope ? "in" : "out of"} team scope (${s.reason})${note}`;
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
    `- project: ${project} (root ${projectRoot(cwd)})`,
    `- terminal commands: ${terminalCommand()} <command>`,
    `- saved notes: ${notes.length}${byKind.length ? ` (${byKind.map(([k, c]) => `${k} ${c}`).join(", ")})` : ""}`,
    ...lifecycleLines(notes, new Set(items.map((i) => i.id))),
    `- captured observations for this project: ${obs.length} (errors: ${obs.filter((o) => o.error).length})`,
    // A capture that stopped long ago while the project is in use points at dead hooks.
    `- last capture in this project: ${obs.length ? localTime(obs.reduce((a, o) => Math.max(a, o.ts), 0)) : "never"}`,
    ...hookHealth(),
    `- capture: ${captureIgnored(cwd) ? "off (.engram-ignore at the project root)" : process.env.ENGRAM_DISABLE_CAPTURE === "1" ? "off (ENGRAM_DISABLE_CAPTURE)" : "on"}`,
    `- team scope: ${teamScope(cwd).inScope ? "in scope" : "out of scope"} (${teamScope(cwd).reason})`,
    `- team folder: ${sharedStore() || "none"}${error ? ` (${error})` : ""}`,
    `- team snapshot: ${snap ? `${snap.items.length} items, ${localTime(snap.at)}` : "none"}`,
    `- team stores: ${teamDirs(cwd).join(", ") || "none"}`,
    `- team items loaded: ${items.length}`,
  ];
  for (const s of skipped) lines.push(`  - skipped ${s.path}: ${s.reason}`);
  return lines.join("\n");
}

const TABLE_NOTES = 10;
const TABLE_ERRORS = 5;
const TABLE_FIXES = 5;

/**
 * Everything engram knows about one table, from this project's view: notes and team items on it
 * (by their tables, or naming it in title or body), the errors queries on it hit most, the fixes
 * that resolved them, and when it was last queried.
 */
function table(name: string): string {
  if (!name.trim()) throw new Error("Usage: engram table <name>");
  const cwd = process.cwd();
  const project = projectId(cwd);
  const ids = identifiers(name);
  const names = (tables: string[]) => matchedTables(ids, tables).length > 0;
  // A name inside prose counts when it is a whole identifier: `dim_users` in "dim_users keeps…".
  const mentions = (text: string) => names([...identifiers(text)].filter((t) => t.length >= 3));

  const notes = allNotes()
    .filter(visibleIn(project))
    .filter((n) => names(n.tables || []) || mentions(`${n.title} ${n.body}`));
  const team = loadTeam(cwd).items.filter(
    (t) => names(t.tables) || mentions(`${t.title} ${t.summary || ""} ${t.body}`),
  );
  const teamIds = new Set(team.map((t) => t.id));
  const fixes = notes.filter((n) => n.kind === "fix" && !teamIds.has(n.id));
  const others = notes.filter((n) => n.kind !== "fix" && !teamIds.has(n.id));

  const runs = projectObservations(project, { skipPrompts: true }).filter((o) =>
    names(extractTables(o.input)),
  );
  const errors = new Map<string, { count: number; last: number }>();
  for (const o of runs) {
    if (!o.error) continue;
    const key = errorHeadline(o.error).replace(/\s+/g, " ").slice(0, 160);
    const e = errors.get(key) || { count: 0, last: 0 };
    e.count++;
    e.last = Math.max(e.last, o.ts);
    errors.set(key, e);
  }
  const touched = Math.max(
    runs.reduce((a, o) => Math.max(a, o.ts), 0),
    notes.reduce((a, n) => Math.max(a, n.ts), 0),
  );
  if (!runs.length && !notes.length && !team.length)
    return `engram knows nothing about ${name} in this project. Search wider with: engram recall ${name} --all`;

  const oneLine = (s: string, max: number) => clip(s.replace(/\s+/g, " ").trim(), max);
  const out = [`engram table: ${name}`];
  out.push(
    `- last touched: ${touched ? localTime(touched) : "never"} ` +
      `(${runs.length} recorded run(s) in this project, ${runs.filter((o) => o.error).length} failed)`,
  );
  if (team.length || others.length) {
    out.push("Caveats and notes:");
    for (const t of team.slice(0, TABLE_NOTES))
      out.push(`- [team ${t.kind}] ${t.title}: ${oneLine(summaryOf(t), 160)} (${t.path})`);
    for (const n of others
      .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || b.ts - a.ts)
      .slice(0, Math.max(0, TABLE_NOTES - team.length)))
      out.push(`- [${n.kind} ${localDay(n.ts)} ${n.id}] ${n.title}: ${oneLine(n.body, 160)}`);
  }
  if (errors.size) {
    out.push("Most common errors:");
    for (const [line, e] of [...errors]
      .sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last)
      .slice(0, TABLE_ERRORS))
      out.push(`- ${e.count}× ${line} (last ${localDay(e.last)})`);
  }
  if (fixes.length) {
    out.push("Fixes that resolved errors:");
    for (const n of fixes.sort((a, b) => b.ts - a.ts).slice(0, TABLE_FIXES))
      out.push(
        `- [fix ${localDay(n.ts)} ${n.id}] ${oneLine(n.title, 140)}: ${oneLine(fixDisplay(n.body), 160)}`,
      );
  }
  return out.join("\n");
}

const kindOrder = (kind: string) => {
  const i = ["caveat", "metric", "decision", "fact", "query", "note"].indexOf(kind);
  return i === -1 ? 99 : i;
};

/** Total bytes under `path`, and how many files. */
function diskUsage(path: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (p: string) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
    else {
      bytes += st.size;
      files++;
    }
  };
  walk(path);
  return { bytes, files };
}

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const TOP_TABLES = 10;

/** How much engram holds: disk use per store, records by kind and source, and the busiest tables. */
function stats(): string {
  const cwd = process.cwd();
  const project = projectId(cwd);
  const dir = dataDir();
  const total = diskUsage(dir);
  const part = (rel: string) => diskUsage(join(dir, rel));
  const obsDisk = part("obs");
  const parts = [
    ["notes.jsonl", part("notes.jsonl")],
    ["hits.jsonl", part("hits.jsonl")],
    ["index", part("index")],
    ["recaps", part("recaps")],
    ["error.log", part("error.log")],
  ] as const;
  const rest = total.bytes - obsDisk.bytes - parts.reduce((a, [, u]) => a + u.bytes, 0);

  const all = allObservations();
  const mine = all.filter((o) => o.project === project);
  const projects = new Set(all.map((o) => o.project)).size;
  const notes = allNotes();
  const byKind = KINDS.map((k) => [k, notes.filter((n) => n.kind === k).length] as const).filter(
    ([, c]) => c,
  );
  const team = loadTeam(cwd).items;

  const counts = new Map<string, number>();
  for (const o of mine) {
    if (o.tool === "prompt") continue;
    for (const t of new Set(extractTables(o.input).map((x) => x.toLowerCase())))
      counts.set(t, (counts.get(t) || 0) + 1);
  }
  const top = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_TABLES);

  const lines = [
    "engram stats",
    `- data dir: ${dir} (${size(total.bytes)} in ${total.files} files)`,
    `  - observations: ${size(obsDisk.bytes)} in ${obsDisk.files} files`,
    `  - ${parts.map(([n, u]) => `${n} ${size(u.bytes)}`).join(", ")}, other ${size(Math.max(0, rest))}`,
    `- observations: ${mine.length} in this project (${mine.filter((o) => o.error).length} errors, ` +
      `${mine.filter((o) => o.tool === "prompt").length} prompts); ${all.length} across ${projects} project(s)`,
    `- notes: ${notes.length}${byKind.length ? ` (${byKind.map(([k, c]) => `${k} ${c}`).join(", ")})` : ""}; ` +
      `${notes.filter(visibleIn(project)).length} recalled in this project`,
    ...lifecycleLines(notes, new Set(team.map((i) => i.id))),
    `- team items loaded here: ${team.length}`,
  ];
  if (top.length) {
    lines.push("- top tables in this project (by recorded runs):");
    for (const [t, c] of top) lines.push(`  - ${t}: ${c}`);
  }
  return lines.join("\n");
}

/** Notes by where they came from, and how many automatic fixes have decayed out of injection. */
function lifecycleLines(notes: Note[], teamIds: Set<string>): string[] {
  const usage = noteUsage();
  const count = (f: (n: Note) => boolean) => notes.filter(f).length;
  const states = notes.map((n) => ({ n, l: lifecycle(n, usage.get(n.id)) }));
  const demoted = states.filter((s) => s.l.state === "demoted");
  const reasons = (["idle", "unconfirmed"] as const)
    .map((r) => [r, demoted.filter((s) => s.l.reason === r).length] as const)
    .filter(([, c]) => c)
    .map(([r, c]) => `${r} ${c}`);
  return [
    `- notes by source: auto ${count((n) => noteSource(n) === "auto" && !teamIds.has(n.id))}, ` +
      `curated ${count((n) => noteSource(n) === "user" && !teamIds.has(n.id))}, ` +
      `shared with the team ${count((n) => teamIds.has(n.id))}; global ${count((n) => !!n.global)}`,
    `- lifecycle: active ${notes.length - demoted.length}, demoted ${demoted.length}` +
      (reasons.length ? ` (${reasons.join(", ")})` : "") +
      ` — automatic fixes not shown for ${DECAY_IDLE_DAYS} days, or shown ${DECAY_MAX_HITS}+ times ` +
      "without their error recurring, leave prompt injection but stay searchable",
  ];
}

/** How to run this CLI from a shell: through the launcher next to it, which finds Node. */
function terminalCommand(): string {
  const script = process.argv[1] || "";
  const launcher = join(dirname(dirname(script)), "hooks", "run-hook.sh");
  return existsSync(launcher) ? `sh "${launcher}"` : `node "${script}"`;
}

const RECENT_ERRORS_MS = 7 * 86_400_000;

/** Hook failures only reach error.log, so status is where they become visible. */
function hookHealth(): string[] {
  const errors = hookErrors();
  if (!errors.length) return ["- hook errors: none logged"];
  const last = errors[errors.length - 1];
  const recent = errors.filter((e) => Date.now() - e.ts < RECENT_ERRORS_MS);
  const lines = [`- hook errors: ${errors.length} logged, last ${localTime(last.ts)}`];
  if (recent.length) {
    lines.push(
      `  WARNING: ${recent.length} hook error(s) in the past 7 days; recall or capture may be failing. Latest:`,
    );
    for (const e of recent.slice(-3))
      lines.push(`  - ${localTime(e.ts)} ${e.message.replace(/\s+/g, " ").slice(0, 200)}`);
    lines.push(`  Full log: ${join(dataDir(), "error.log")}`);
  }
  return lines;
}

/**
 * Deletes records that match, rather than blanking them. A secret that reached storage should
 * not leave a redaction marker behind, because the marker still records where it sat.
 */
function purge(target: string): string {
  if (!target) throw new Error("Usage: engram purge <regex|obs-id>");
  const byId = target.startsWith("obs-");
  let matches: (text: string, id?: string) => boolean;
  if (byId) matches = (_text, id) => id === target;
  else {
    let re: RegExp;
    try {
      re = new RegExp(target, "i");
    } catch (e) {
      throw new Error(`Invalid regular expression: ${(e as Error).message}`);
    }
    matches = (text) => re.test(text);
  }
  const report = rewriteStores((text, record) => (matches(text, record.id) ? null : text));
  return [
    `Purged ${target}`,
    `- observations: ${report.observations}`,
    `- notes: ${report.notes}`,
    `- recaps: ${report.recaps}`,
  ].join("\n");
}

/** Re-applies the current sanitizer rules, so a rule added later also cleans older records. */
function resanitize(): string {
  const report = rewriteStores((text) => sanitize(text));
  return [
    "Resanitized stored text",
    `- observations: ${report.observations}`,
    `- notes: ${report.notes}`,
    `- recaps: ${report.recaps}`,
  ].join("\n");
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
    else if (cmd === "save") out = save(opt, pos.includes("--global"));
    else if (cmd === "forget")
      out = forget(pos[0] || "") ? `Forgot ${pos[0]}` : `No saved note with id "${pos[0]}"`;
    else if (cmd === "purge") out = purge(pos[0] || "");
    else if (cmd === "resanitize") out = resanitize();
    else if (cmd === "share")
      out = share(
        pos.find((p) => !p.startsWith("--")),
        opt,
        pos.includes("--yes"),
        pos.includes("--update"),
      );
    else if (cmd === "scope") out = scope(pos[0]);
    else if (cmd === "history") out = history(pos, opt);
    else if (cmd === "status") out = status();
    else if (cmd === "table") out = table(pos.join(" "));
    else if (cmd === "stats") out = stats();
    else out = USAGE;
    console.log(out);
    runDeferred();
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
