import { describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import {
  type DocOptions,
  buildDocs,
  formatHit,
  obsDoc,
  onToolUse,
  recallSearch,
  runDeferred,
} from "../src/hooks";
import {
  dataDir,
  indexRoot,
  observationDir,
  projectId,
  projectRoot,
  pruneObservations,
  recordHits,
  rewriteStores,
  saveNote,
} from "../src/memory";
import { indexedCandidates, rebuildIndex } from "../src/postings";
import { sanitize } from "../src/sanitizer";
import { type Hit, queryTerms, search } from "../src/search";
import { joinTeam, sandbox } from "./helpers";

const ev = (work: string, session: string, extra: object) =>
  ({ session_id: session, cwd: work, ...extra }) as any;

const bash = (work: string, session: string, command: string, error?: string) =>
  onToolUse(
    ev(work, session, {
      hook_event_name: error ? "PostToolUseFailure" : "PostToolUse",
      tool_name: "Bash",
      tool_input: { command },
      error,
    }),
  );

const shape = (hits: Hit[]) =>
  hits.map((h) => ({ id: h.doc.id, score: h.score, line: formatHit(h), group: h.doc.group }));

/** The reference: a full scan through buildDocs and search(). */
const fullScan = (work: string, q: string, opts: DocOptions, minIdf: number) =>
  shape(search(buildDocs(work, opts), q, 20, minIdf));

const indexed = (work: string, q: string, opts: DocOptions, minIdf: number) =>
  shape(recallSearch(work, q, opts, 20, minIdf).hits);

/** True when the index answers by itself (no full-scan fallback). */
const indexFresh = (work: string) =>
  indexedCandidates(projectId(work), queryTerms("x"), () => true, obsDoc) !== null;

/**
 * Notes of two projects (one global, one demoted auto fix, a fix whose source observations every
 * search drops), team items in scope, and observations across sessions: errors, file edits that
 * collapse into one group, prompts, substring-only matches (`update` holds `date`, `superusers`
 * holds `users`), identical timestamps, and Japanese.
 */
function mixedStore() {
  const { work } = sandbox();
  mkdirSync(join(work, ".git"), { recursive: true });
  const other = join(work, "other");
  mkdirSync(join(other, ".git"), { recursive: true });
  const project = projectId(work);
  const team = process.env.ENGRAM_TEAM_DIR!;
  mkdirSync(join(team, "caveats"), { recursive: true });
  writeFileSync(
    join(team, "caveats", "users.md"),
    "---\nid: team-users\ntitle: dim_users soft deletes\ntarget_tables: [dim_users]\n---\nFilter deleted_at IS NULL for active users.",
  );
  joinTeam(work);
  saveNote({
    project,
    kind: "caveat",
    title: "orders double count refunds",
    body: "fct_orders has refunds as negative rows; signup date is UTC",
    tables: ["fct_orders"],
    root: projectRoot(work),
  });
  saveNote({
    project: projectId(other),
    kind: "metric",
    title: "revenue definition",
    body: "revenue excludes tax; 売上は税抜",
    global: true,
    root: projectRoot(other),
  });
  saveNote({
    project: projectId(other),
    kind: "caveat",
    title: "other project users quirk",
    body: "users table in the other repo",
    root: projectRoot(other),
  });
  // A paired fix: its two observations leave every search.
  bash(
    work,
    "s1",
    "bq query 'SELECT signup_dt FROM analytics.dim_users'",
    "Unrecognized name: signup_dt",
  );
  bash(work, "s1", "bq query 'SELECT signup_date FROM analytics.dim_users'");
  const demoted = saveNote({
    project,
    kind: "fix",
    title: "Fix: country column missing",
    body: "Worked:\n```\nSELECT country FROM dim_users\n```",
    tables: ["dim_users"],
    source: "auto",
    session: "s0",
    root: projectRoot(work),
  });
  recordHits(Array(10).fill(demoted.id));

  const sessions = ["s1", "s2", "s3", "current"];
  const commands = [
    "bq query 'SELECT country, count(*) FROM analytics.dim_users GROUP BY 1'",
    "psql -c 'UPDATE superusers SET active = true'",
    "bq query 'SELECT revenue, signup_date FROM fct_orders WHERE country = \"JP\"'",
    "python scripts/load_users.py --since 2024-01-01",
    "bq query 'SELECT 売上, 国 FROM 売上テーブル'",
    "dbt run --select fct_orders+",
  ];
  sessions.forEach((s, k) =>
    commands.forEach((c, j) => {
      if ((k + j) % 3 === 0) bash(work, s, c, "Exit code 1\nSyntax error near users");
      else bash(work, s, `${c} -- ${k}`);
    }),
  );
  for (const v of [1, 2, 3])
    onToolUse(
      ev(work, "s2", {
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: "/w/models/users.sql",
          content: `SELECT * FROM dim_users -- v${v}`,
        },
      }),
    );
  onToolUse(
    ev(work, "s3", {
      hook_event_name: "PostToolUse",
      tool_name: "mcp__bigquery__execute_sql",
      tool_input: { sql: "SELECT user_id FROM dim_users WHERE signup_date > '2024-01-01'" },
    }),
  );
  // Prompts and two records with the same timestamp, written as the hooks would.
  const log = join(observationDir(project), "s2.jsonl");
  for (const [id, input] of [
    ["obs-same-a", "bq query 'SELECT users FROM same_ts'"],
    ["obs-same-b", "bq query 'SELECT users FROM same_ts'"],
  ])
    appendFileSync(
      log,
      `${JSON.stringify({ t: "obs", id, ts: 1_700_000_000_000, session: "s2", project, tool: "Bash", input })}\n`,
    );
  // The same record in two sessions: equal score and time, so only the corpus order ranks them.
  for (const session of ["s2", "s3"])
    appendFileSync(
      join(observationDir(project), `${session}.jsonl`),
      `${JSON.stringify({ t: "obs", id: `obs-tie-${session}`, ts: 1_600_000_000_000, session, project, tool: "Bash", input: "bq query 'SELECT tiebreak FROM dim_users'" })}\n`,
    );
  appendFileSync(
    log,
    `${JSON.stringify({ t: "obs", id: "obs-p1", ts: 1_700_000_000_001, session: "s2", project, tool: "prompt", input: "why do users double count revenue" })}\n`,
  );
  return { work, project };
}

const QUERIES = [
  "tiebreak",
  "count dim_users by country",
  "signup date revenue",
  "users",
  "date",
  "売上 国",
  "superusers update",
  "fct_orders refunds",
  "why do users double count revenue",
  "nothing matches zzz",
];
const OPTIONS: DocOptions[] = [
  {},
  { excludeSession: "current", prompts: false, injection: true },
  { allProjects: true },
  { excludeSession: "s2" },
];

describe("postings index", () => {
  it("returns exactly the full scan's hits, in order, from base and delta", () => {
    const { work, project } = mixedStore();
    rebuildIndex(project, obsDoc);
    expect(indexFresh(work)).toBe(true);
    const compare = () => {
      for (const q of QUERIES)
        for (const opts of OPTIONS)
          for (const minIdf of [0, 3]) {
            const ref = fullScan(work, q, opts, minIdf);
            expect(indexed(work, q, opts, minIdf)).toEqual(ref);
          }
    };
    compare();
    // New captures go to the delta; the index stays fresh and still matches.
    bash(
      work,
      "s4",
      "bq query 'SELECT country, revenue FROM fct_orders'",
      "Exit code 1\nBad users",
    );
    bash(work, "current", "psql -c 'UPDATE dim_users SET country = NULL'");
    expect(existsSync(join(indexRoot(), project, "delta.jsonl"))).toBe(true);
    expect(indexFresh(work)).toBe(true);
    compare();
    // Some query must actually rank a few observations, or the comparison proves little.
    const sample = indexed(work, "users", {}, 0);
    expect(sample.filter((h) => h.id.startsWith("obs-")).length).toBeGreaterThan(3);
  });

  it("falls back to a full scan when a log grew behind its back, then rebuilds", () => {
    const { work, project } = mixedStore();
    rebuildIndex(project, obsDoc);
    appendFileSync(
      join(observationDir(project), "s3.jsonl"),
      `${JSON.stringify({ t: "obs", id: "obs-late", ts: 1_800_000_000_000, session: "s3", project, tool: "Bash", input: "bq query 'SELECT latecomer FROM dim_users'" })}\n`,
    );
    expect(indexFresh(work)).toBe(false);
    expect(indexed(work, "latecomer", {}, 0).map((h) => h.id)).toEqual(["obs-late"]);
    runDeferred();
    expect(indexFresh(work)).toBe(true);
    expect(indexed(work, "latecomer", {}, 0)).toEqual(fullScan(work, "latecomer", {}, 0));
  });

  it("never serves purged or re-redacted text from a warm index", () => {
    const { work, project } = mixedStore();
    const secret = ["hf_", "Q".repeat(34)].join("");
    bash(work, "s5", `curl -H 'x: marker-zz9' https://x/${"a".repeat(3)}`);
    // Written raw, as a version without the Hugging Face rule would have stored it.
    appendFileSync(
      join(observationDir(project), "s5.jsonl"),
      `${JSON.stringify({ t: "obs", id: "obs-hf", ts: 2, session: "s5", project, tool: "Bash", input: `huggingface-cli login --token ${secret}` })}\n`,
    );
    rebuildIndex(project, obsDoc);
    expect(indexed(work, "marker-zz9", {}, 0).length).toBe(1);
    rewriteStores((text) => (text.includes("marker-zz9") ? null : text));
    expect(indexed(work, "marker-zz9", {}, 0)).toEqual([]);

    rebuildIndex(project, obsDoc);
    expect(indexed(work, "huggingface login", {}, 0)[0].line).toContain(secret);
    rewriteStores((text) => sanitize(text));
    const after = indexed(work, "huggingface login", {}, 0);
    expect(after.length).toBe(1);
    expect(after[0].line).not.toContain(secret);
    expect(after).toEqual(fullScan(work, "huggingface login", {}, 0));
  });

  it("drops the index when a rewrite keeps every log's size", () => {
    const { work, project } = mixedStore();
    bash(work, "s6", "bq query 'SELECT colzzq1 FROM dim_users'");
    rebuildIndex(project, obsDoc);
    expect(indexed(work, "colzzq1", {}, 0).length).toBe(1);
    // Same length in and out, so no size changes: only the explicit invalidation can tell.
    rewriteStores((text) => text.replace("colzzq1", "colzzq2"));
    expect(indexed(work, "colzzq1", {}, 0)).toEqual([]);
    expect(indexed(work, "colzzq2", {}, 0)).toEqual(fullScan(work, "colzzq2", {}, 0));
    expect(indexed(work, "colzzq2", {}, 0).length).toBe(1);
  });

  it("drops the index when pruning deletes logs", () => {
    const { work, project } = mixedStore();
    rebuildIndex(project, obsDoc);
    const dir = observationDir(project);
    const old = new Date(Date.now() - 400 * 86_400_000);
    for (const f of readdirSync(dir)) {
      if (f.startsWith("s1.")) require("fs").utimesSync(join(dir, f), old, old);
    }
    expect(pruneObservations(90)).toBeGreaterThan(0);
    expect(existsSync(join(indexRoot(), project))).toBe(false);
    for (const q of QUERIES) expect(indexed(work, q, {}, 0)).toEqual(fullScan(work, q, {}, 0));
  });

  it("answers like a full scan from a missing, corrupt, truncated or torn index", () => {
    const { work, project } = mixedStore();
    const base = join(indexRoot(), project, "base.idx");
    const delta = join(indexRoot(), project, "delta.jsonl");
    const check = () => {
      for (const q of QUERIES.slice(0, 4))
        expect(indexed(work, q, {}, 0)).toEqual(fullScan(work, q, {}, 0));
    };
    check();
    rebuildIndex(project, obsDoc);
    writeFileSync(base, "not an index at all");
    check();
    rebuildIndex(project, obsDoc);
    const text = require("fs").readFileSync(base, "utf-8") as string;
    writeFileSync(base, text.slice(0, Math.floor(text.length / 2)));
    check();
    rebuildIndex(project, obsDoc);
    writeFileSync(base, text.replace(/^D\t[^\n]*\n/m, ""));
    check();
    rebuildIndex(project, obsDoc);
    bash(work, "s1", "bq query 'SELECT torn FROM dim_users'");
    appendFileSync(delta, '{"f":"s1.jsonl","b":');
    check();
    unlinkSync(delta);
    check();
  });

  it("is kept current by the async refresh hook", () => {
    const { work, project } = mixedStore();
    expect(indexFresh(work)).toBe(false);
    // The refresh hook (SessionStart, async) and Stop rebuild a stale index.
    require("../src/hooks").onRefresh(ev(work, "s1", { hook_event_name: "SessionStart" }));
    expect(indexFresh(work)).toBe(true);
    expect(existsSync(join(dataDir(), "index", project, "base.idx"))).toBe(true);
  });
});

/**
 * 20,000 observations in 200 sessions, written straight to the logs: warehouse queries of a
 * realistic length over 300 tables, one in eight failing, one in ten a prompt.
 */
function largeStore(work: string, n = 20_000) {
  const project = projectId(work);
  const dir = observationDir(project);
  mkdirSync(dir, { recursive: true });
  const kinds = ["users", "orders", "events", "sessions", "payments", "refunds"];
  const tables = Array.from({ length: 300 }, (_, i) => `analytics.tbl_${kinds[i % 6]}_${i}`);
  const cols =
    "user_id order_id created_at amount country status signup_date revenue channel device".split(
      " ",
    );
  let seed = 42;
  const r = (m: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % m;
  for (let s = 0; s < n / 100; s++) {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      const k = s * 100 + i;
      const t = tables[r(tables.length)];
      const c = [cols[r(10)], cols[r(10)], cols[r(10)]].join(", ");
      const prompt = r(10) === 0;
      const o: Record<string, unknown> = {
        t: "obs",
        id: `obs-${k}`,
        ts: 1_700_000_000_000 + k * 1000,
        session: `sess-${s}`,
        project,
        tool: prompt ? "prompt" : "Bash",
        input: prompt
          ? `show me ${cols[r(10)]} by ${cols[r(10)]} for ${t} last month 売上を集計して`
          : `bq query --use_legacy_sql=false 'SELECT ${c}, count(*) AS n FROM ${t} WHERE ${cols[r(10)]} > 10 GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 100'`,
      };
      if (!prompt && r(8) === 0)
        o.error = `Exit code 1\nError in query string: Unrecognized name: ${cols[r(10)]}_x at [1:${r(80)}]`;
      lines.push(JSON.stringify(o));
    }
    writeFileSync(join(dir, `sess-${s}.jsonl`), `${lines.join("\n")}\n`);
  }
  return project;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function time(f: () => unknown, runs = 3): number {
  const out: number[] = [];
  for (let k = 0; k < runs; k++) {
    const s = performance.now();
    f();
    out.push(performance.now() - s);
  }
  return median(out);
}

describe("prompt-time recall latency at 20,000 observations", () => {
  // Measured on the development VM (bun, in process): full scan about 380-430 ms, indexed about
  // 65-75 ms. Under node, the whole `hook prompt` went from 739 ms to 287 ms (median of 9).
  it(
    "is several times faster with the index and returns the same hits",
    () => {
      const { work } = sandbox();
      mkdirSync(join(work, ".git"), { recursive: true });
      const project = largeStore(work);
      const q = "why does tbl_orders_7 revenue by country fail with signup_date";
      const opts: DocOptions = { excludeSession: "now", prompts: false, injection: true };
      rebuildIndex(project, obsDoc);
      expect(indexFresh(work)).toBe(true);
      expect(indexed(work, q, opts, 3)).toEqual(fullScan(work, q, opts, 3));

      const full = time(() => search(buildDocs(work, opts), q, 20), 5);
      const fast = time(() => recallSearch(work, q, opts, 20), 5);
      console.log(
        `recall at 20k observations: full scan ${full.toFixed(0)} ms, indexed ${fast.toFixed(0)} ms`,
      );
      // Relative, so slower CI runners do not flake. The ceiling sits at about half the full scan's
      // time on the development VM and about three times the indexed path's; CI raises it
      // (ENGRAM_LATENCY_CEILING_MS) for shared runners.
      expect(fast).toBeLessThan(full / 2);
      expect(fast).toBeLessThan(Number(process.env.ENGRAM_LATENCY_CEILING_MS) || 200);
    },
    { timeout: 120_000 },
  );
});
