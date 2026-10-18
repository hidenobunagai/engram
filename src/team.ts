import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import type { Kind } from "./memory";
import { projectRoot } from "./memory";
import { sanitize } from "./sanitizer";

/** Team knowledge: Markdown files with frontmatter in a git repo the team reviews via PRs. */
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
 * Active team stores, highest priority first: ENGRAM_TEAM_DIR, else the nearest project
 * `.engram/` (up to the repo root) followed by ~/.claude/engram-team.
 */
export function teamDirs(cwd: string): string[] {
  if (process.env.ENGRAM_TEAM_DIR) return [resolve(process.env.ENGRAM_TEAM_DIR)];
  const dirs: string[] = [];
  const root = projectRoot(cwd);
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".engram"))) {
      dirs.push(join(dir, ".engram"));
      break;
    }
    if (dir === root || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  const global = join(homedir(), ".claude", "engram-team");
  if (existsSync(global)) dirs.push(global);
  return dirs;
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

/** Loads every store; a higher-priority store overrides items with the same id. */
export function loadTeam(cwd: string): LoadResult {
  const byId = new Map<string, TeamItem>();
  const skipped: LoadResult["skipped"] = [];
  for (const base of [...teamDirs(cwd)].reverse()) {
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
          byId.set(id, {
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
  }
  return { items: [...byId.values()].filter((i) => i.status !== "deprecated"), skipped };
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
 * Returns the path; committing and opening a PR is left to the user.
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
