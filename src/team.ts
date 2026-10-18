import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import type { Kind } from "./memory";
import { dataDir, projectRoot } from "./memory";
import { sanitize } from "./sanitizer";

/** Team knowledge: Markdown files with frontmatter in a shared folder (network drive or git clone). */
export interface TeamItem {
  id: string;
  kind: Kind;
  title: string;
  summary?: string;
  tables: string[];
  tags: string[];
  author?: string;
  status?: string;
  created_at?: string;
  body: string;
  path: string;
}

export const TEAM_KINDS: Kind[] = ["caveat", "metric", "query", "decision", "fact", "fix", "note"];
const FOLDER: Record<Kind, string> = {
  caveat: "caveats",
  metric: "metrics",
  query: "queries",
  decision: "decisions",
  fact: "facts",
  fix: "fixes",
  note: "notes",
};

/**
 * Personal settings in <data dir>/config.json: the team folder (persisted from the plugin's
 * `team_dir` option so commands run outside hooks see it too) and the projects the user selected
 * with `engram scope on`.
 */
export interface Config {
  teamDir?: string;
  projects?: Array<{ root: string; remote?: string }>;
}

const configFile = () => join(dataDir(), "config.json");

export function readConfig(): Config {
  try {
    const c = JSON.parse(readFileSync(configFile(), "utf-8"));
    return c && typeof c === "object" && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}

export function writeConfig(c: Config): void {
  writeAtomic(configFile(), `${JSON.stringify(c, null, 2)}\n`);
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, file);
}

/** Hooks receive the plugin option; remember it so CLI commands use the same folder. */
export function persistPluginOption(): void {
  const opt = process.env.CLAUDE_PLUGIN_OPTION_TEAM_DIR?.trim();
  const c = readConfig();
  if (opt && opt !== c.teamDir) writeConfig({ ...c, teamDir: opt });
}

/**
 * The shared team folder (a network drive such as S:\\analytics\\engram, or a git clone):
 * ENGRAM_TEAM_DIR, the plugin's `team_dir` option, config.json, else ~/.claude/engram-team if it
 * exists. A configured folder is returned without touching it, because it may be slow or offline.
 */
export function sharedStore(): string | undefined {
  const configured =
    process.env.ENGRAM_TEAM_DIR?.trim() ||
    process.env.CLAUDE_PLUGIN_OPTION_TEAM_DIR?.trim() ||
    readConfig().teamDir;
  if (configured) return resolve(configured);
  const fallback = join(homedir(), ".claude", "engram-team");
  return existsSync(fallback) ? fallback : undefined;
}

/** Active team stores, highest priority first: the project's `.engram/`, then the shared folder. */
export function teamDirs(cwd: string): string[] {
  return [projectStore(cwd), sharedStore()].filter((d): d is string => !!d);
}

/** Nearest `.engram/` between cwd and the repository root. */
export function projectStore(cwd: string): string | undefined {
  const root = projectRoot(cwd);
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".engram"))) return join(dir, ".engram");
    if (dir === root || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}

/** The origin (else first) remote URL from .git/config, read directly so no git process is spawned. */
export function gitRemote(root: string): string | undefined {
  try {
    let gitDir = join(root, ".git");
    if (statSync(gitDir).isFile()) {
      // Worktree or submodule: ".git" is a file pointing at the real git dir; config lives in its commondir.
      gitDir = resolve(
        root,
        readFileSync(gitDir, "utf-8")
          .replace(/^gitdir:\s*/, "")
          .trim(),
      );
      const common = join(gitDir, "commondir");
      if (existsSync(common)) gitDir = resolve(gitDir, readFileSync(common, "utf-8").trim());
    }
    const config = readFileSync(join(gitDir, "config"), "utf-8");
    const remotes = [...config.matchAll(/\[remote "([^"]+)"\]([^[]*)/g)].map((m) => ({
      name: m[1],
      url: m[2].match(/^\s*url\s*=\s*(.+)$/m)?.[1].trim(),
    }));
    return (remotes.find((r) => r.name === "origin") || remotes[0])?.url;
  } catch {
    return undefined;
  }
}

/** git@github.com:org/repo.git and https://github.com/org/repo -> github.com/org/repo */
export function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d+\/)/, "$1/")
    .replace(/^([^/:]+):\d+\//, "$1/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

/** `*` matches any characters, including "/". The whole string must match. */
function globMatch(pattern: string, text: string): boolean {
  const re = pattern
    .trim()
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${re}$`).test(text.toLowerCase());
}

/** Forward slashes; case-insensitive on Windows, where C:\\Work and c:\\work are the same folder. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const s = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

interface ScopeFile {
  projects: string[];
  paths: string[];
}

function readScopeFile(base: string): { scope: ScopeFile | null; error?: string } {
  const file = join(base, "scope.json");
  if (!existsSync(file)) return { scope: null };
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    const strings = (v: unknown) =>
      v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      !strings(raw.projects) ||
      !strings(raw.paths)
    )
      throw new Error('expected {"projects": [strings], "paths": [strings]}');
    return { scope: { projects: raw.projects || [], paths: raw.paths || [] } };
  } catch (e) {
    return { scope: null, error: `scope.json is invalid: ${(e as Error).message}` };
  }
}

/**
 * Local copy of the shared folder (scope.json plus parsed items) so prompt-time hooks never wait on a
 * network drive. Refreshed by async hooks and by commands that read the folder on purpose.
 */
export interface Snapshot {
  dir: string;
  at: number;
  scope: ScopeFile | null;
  scopeError?: string;
  items: TeamItem[];
  skipped: Array<{ path: string; reason: string }>;
}

const snapshotFile = () => join(dataDir(), "team-snapshot.json");

export function readSnapshot(): Snapshot | null {
  const dir = sharedStore();
  if (!dir) return null;
  try {
    const snap = JSON.parse(readFileSync(snapshotFile(), "utf-8")) as Snapshot;
    return samePath(snap.dir, dir) ? snap : null;
  } catch {
    return null;
  }
}

/**
 * Re-reads the shared folder unless the snapshot is younger than `maxAgeMs`. A lock file keeps hung
 * refreshes (an offline share) from piling up. Returns the previous snapshot if the folder is
 * unreachable, plus the error.
 */
export function refreshSnapshot(maxAgeMs = 0): { snap: Snapshot | null; error?: string } {
  const dir = sharedStore();
  if (!dir) return { snap: null };
  const prev = readSnapshot();
  if (prev && Date.now() - prev.at < maxAgeMs) return { snap: prev };
  const lock = `${snapshotFile()}.lock`;
  try {
    if (maxAgeMs > 0 && Date.now() - statSync(lock).mtimeMs < 120_000) return { snap: prev };
  } catch {
    // No lock: go ahead.
  }
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(lock, String(process.pid));
  try {
    if (!existsSync(dir)) return { snap: prev, error: `team folder not reachable: ${dir}` };
    const { scope, error } = readScopeFile(dir);
    const snap: Snapshot = { dir, at: Date.now(), scope, ...scanStore(dir) };
    if (error) snap.scopeError = error;
    writeAtomic(snapshotFile(), JSON.stringify(snap));
    return { snap };
  } catch (e) {
    return { snap: prev, error: (e as Error).message };
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // Already gone.
    }
  }
}

export interface Scope {
  inScope: boolean;
  reason: string;
}

/**
 * Whether team knowledge applies to this project, in both directions: it is injected here, and notes
 * saved here may be shared. In scope when the project has a `.engram/` folder, when no team folder is
 * configured (nothing to share with), when the user selected it (`engram scope on`), or when the
 * team's scope.json lists its git remote or path. Everything else is out, so personal sessions stay
 * personal. Reads only local files and the snapshot.
 */
export function teamScope(cwd: string): Scope {
  if (projectStore(cwd)) return { inScope: true, reason: "project has a .engram/ folder" };
  if (!sharedStore()) return { inScope: true, reason: "no team folder configured" };
  const root = projectRoot(cwd);
  const remote = gitRemote(root);
  const norm = remote ? normalizeRemote(remote) : "";
  const picked = (readConfig().projects || []).find(
    (p) => samePath(p.root, root) || (!!norm && p.remote === norm),
  );
  if (picked) return { inScope: true, reason: "selected with /engram:scope on" };
  const snap = readSnapshot();
  if (snap?.scopeError) return { inScope: false, reason: snap.scopeError };
  const cfg = snap?.scope;
  const hitProject =
    cfg && norm ? cfg.projects.find((p) => globMatch(normalizeRemote(p), norm)) : undefined;
  if (hitProject)
    return { inScope: true, reason: `remote ${norm} matches "${hitProject}" in scope.json` };
  const path = root.replace(/\\/g, "/");
  const home = homedir().replace(/\\/g, "/");
  const hitPath = cfg?.paths.find((p) =>
    globMatch(p.replace(/\\/g, "/").replace(/^~(?=\/|$)/, home), path),
  );
  if (hitPath) return { inScope: true, reason: `path ${path} matches "${hitPath}" in scope.json` };
  return {
    inScope: false,
    reason: `not selected (remote: ${norm || "none"}, path: ${path}); run /engram:scope on here to include it`,
  };
}

/** Adds or removes the current project from the user's selection. */
export function setSelected(cwd: string, on: boolean): void {
  const root = projectRoot(cwd);
  const remote = gitRemote(root);
  const norm = remote ? normalizeRemote(remote) : undefined;
  const c = readConfig();
  const rest = (c.projects || []).filter(
    (p) => !samePath(p.root, root) && !(norm && p.remote === norm),
  );
  writeConfig({ ...c, projects: on ? [...rest, norm ? { root, remote: norm } : { root }] : rest });
}

/** Minimal YAML subset: `key: scalar`, `key: [a, "b"]`, and block lists (`key:` then `- a`). */
export function parseFrontmatter(content: string): {
  meta: Record<string, string | string[]>;
  body: string;
} {
  const text = content.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };

  const meta: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const raw of m[1].split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      (meta[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    listKey = null;
    if (val === "") {
      meta[key] = [];
      listKey = key;
    } else if (val.startsWith("[") && val.endsWith("]")) {
      meta[key] = splitInline(val.slice(1, -1));
    } else {
      meta[key] = unquote(val);
    }
  }
  return { meta, body: m[2].trim() };
}

function unquote(v: string): string {
  const s = v.trim();
  const dq = s.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
  if (dq) {
    try {
      return JSON.parse(dq[1]);
    } catch {
      return dq[1].slice(1, -1);
    }
  }
  const sq = s.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
  if (sq) return sq[1].replace(/''/g, "'");
  return s.replace(/\s+#.*$/, "");
}

/** Splits `a, "b, c", 'd'` respecting quotes. */
function splitInline(inner: string): string[] {
  const out: string[] = [];
  for (const m of inner.matchAll(/\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+)\s*(?:,|$)/g)) {
    const v = unquote(m[1]);
    if (v) out.push(v);
  }
  return out;
}

const asList = (v: string | string[] | undefined): string[] =>
  v === undefined || v === "" ? [] : Array.isArray(v) ? v : [v];
const asText = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v.join(", ") || undefined : v || undefined;

export interface LoadResult {
  items: TeamItem[];
  skipped: Array<{ path: string; reason: string }>;
}

/** Parses every item of one store. */
function scanStore(base: string): { items: TeamItem[]; skipped: LoadResult["skipped"] } {
  const items: TeamItem[] = [];
  const skipped: LoadResult["skipped"] = [];
  for (const kind of TEAM_KINDS) {
    const dir = join(base, FOLDER[kind]);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const path = join(dir, f);
      try {
        const { meta, body } = parseFrontmatter(readFileSync(path, "utf-8"));
        const id = asText(meta.id);
        const title = asText(meta.title);
        if (!id || !title) {
          skipped.push({ path, reason: "missing id or title in frontmatter" });
          continue;
        }
        items.push({
          id,
          kind: (TEAM_KINDS as string[]).includes(asText(meta.kind) || "")
            ? (asText(meta.kind) as Kind)
            : kind,
          title,
          summary: asText(meta.summary),
          tables: asList(meta.target_tables ?? meta.tables),
          tags: asList(meta.tags),
          author: asText(meta.author),
          status: asText(meta.status),
          created_at: asText(meta.created_at),
          body,
          path,
        });
      } catch (e) {
        skipped.push({ path, reason: (e as Error).message });
      }
    }
  }
  return { items, skipped };
}

/**
 * Team items for this project: nothing outside the team scope; otherwise the shared folder (from the
 * snapshot) overridden by the project's `.engram/` (read directly, it is local) for the same id.
 */
export function loadTeam(cwd: string): LoadResult {
  if (!teamScope(cwd).inScope) return { items: [], skipped: [] };
  const shared = readSnapshot();
  const local = projectStore(cwd);
  const own = local ? scanStore(local) : { items: [], skipped: [] };
  const byId = new Map<string, TeamItem>();
  for (const i of [...(shared?.items || []), ...own.items]) byId.set(i.id, i);
  return {
    items: [...byId.values()].filter((i) => i.status !== "deprecated"),
    skipped: [...(shared?.skipped || []), ...own.skipped],
  };
}

/** First meaningful line of the body when no `summary:` is given. */
export function summaryOf(item: { summary?: string; body: string }): string {
  if (item.summary) return item.summary;
  const line = item.body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith("```") && !/^[-*_]{3,}$/.test(l));
  return line ? line.replace(/^[-*>]\s+/, "") : "";
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** JSON strings are valid YAML double-quoted scalars and survive the round trip. */
const q = (s: string) => JSON.stringify(s.replace(/[\r\n]+/g, " ").trim());

export function serialize(item: Omit<TeamItem, "path">): string {
  const lines = ["---", `id: ${q(item.id)}`, `kind: ${q(item.kind)}`, `title: ${q(item.title)}`];
  if (item.summary) lines.push(`summary: ${q(item.summary)}`);
  if (item.tables.length) lines.push(`target_tables: [${item.tables.map(q).join(", ")}]`);
  if (item.tags.length) lines.push(`tags: [${item.tags.map(q).join(", ")}]`);
  if (item.author) lines.push(`author: ${q(item.author)}`);
  if (item.created_at) lines.push(`created_at: ${q(item.created_at)}`);
  lines.push("---", "", item.body.trim(), "");
  return lines.join("\n");
}

/**
 * Writes a new team file. Never overwrites: an existing file with another id gets a suffix.
 * Returns the path. In a shared folder the file is visible to the team immediately.
 */
export function writeTeamItem(base: string, item: Omit<TeamItem, "path">): string {
  const clean: Omit<TeamItem, "path"> = {
    ...item,
    title: sanitize(item.title),
    summary: item.summary ? sanitize(item.summary) : undefined,
    body: sanitize(item.body),
    tables: item.tables.map(sanitize),
    tags: item.tags.map(sanitize),
  };
  const dir = join(base, FOLDER[clean.kind]);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stem = slugify(clean.title) || clean.id;
  let path = join(dir, `${stem}.md`);
  for (let n = 2; existsSync(path); n++) {
    if (parseFrontmatter(readFileSync(path, "utf-8")).meta.id === clean.id) break;
    path = join(dir, `${stem}-${n}.md`);
  }
  writeFileSync(path, serialize(clean), "utf-8");
  return path;
}
