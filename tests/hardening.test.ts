import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { onPrompt, onSessionStart, onToolUse } from "../src/hooks";
import { allNotes, dataDir, projectId, projectObservations } from "../src/memory";
import { loadTeam, readText, refreshSnapshot, setSelected, teamScope } from "../src/team";
import { sandbox } from "./helpers";

const ev = (work: string, session: string, extra: object) =>
  ({ session_id: session, cwd: work, ...extra }) as any;

/** `売上テーブルの注意` with a body holding ① and 髙, saved by Notepad on Japanese Windows (CP932). */
const CP932 =
  "2d2d2d0a69643a2063703933322d310a7469746c653a2094848fe38365815b8375838b82cc928d88d30a7461726765745f7461626c65733a205b6663745f73616c65735d0a2d2d2d0a95d4956982cd97828c8e82c98c768fe382b382ea82e98142874082e2eee082cc82e682a482c88b408eed88cb91b695b68e9a82e08adc82de81420a";

describe("team files in CP932", () => {
  it("reads a Shift_JIS Markdown file without corrupting the Japanese", () => {
    const { work } = sandbox();
    const dir = join(work, ".engram", "caveats");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sales.md"), Buffer.from(CP932, "hex"));
    const [item] = loadTeam(work).items;
    expect(item.title).toBe("売上テーブルの注意");
    expect(item.body).toBe("返品は翌月に計上される。①や髙のような機種依存文字も含む。");
    expect(item.tables).toEqual(["fct_sales"]);
    expect(JSON.stringify(item)).not.toContain("�");
  });

  it("still reads UTF-8, with or without a BOM, as UTF-8", () => {
    const { work } = sandbox();
    const file = join(work, "a.md");
    writeFileSync(file, "---\nid: u\ntitle: 売上\n---\n本文");
    expect(readText(file)).toBe("---\nid: u\ntitle: 売上\n---\n本文");
    writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("売上")]));
    expect(readText(file).replace(/^﻿/, "")).toBe("売上");
  });
});

/** A repository with an origin remote, and a team folder holding one caveat. */
function teamAndRepo(scopeJson?: string) {
  const { work } = sandbox();
  const repo = join(work, "kpi");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(
    join(repo, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:acme-analytics/kpi.git\n',
  );
  const team = process.env.ENGRAM_TEAM_DIR!;
  mkdirSync(join(team, "caveats"), { recursive: true });
  writeFileSync(
    join(team, "caveats", "a.md"),
    '---\nid: c1\ntitle: Soft deletes in dim_users\ntarget_tables: ["dim_users"]\n---\nFilter deleted_at IS NULL.',
  );
  if (scopeJson !== undefined) writeFileSync(join(team, "scope.json"), scopeJson);
  refreshSnapshot(0);
  return repo;
}

/** Nothing from the team reaches this project, in either direction. */
function sharesNothing(repo: string) {
  expect(teamScope(repo).inScope).toBe(false);
  expect(loadTeam(repo).items).toEqual([]);
  const ctx = onPrompt(
    ev(repo, "s1", { hook_event_name: "UserPromptSubmit", prompt: "dim_users soft deletes" }),
  );
  expect(ctx).not.toContain("Soft deletes in dim_users");
  expect(onSessionStart(ev(repo, "s2", { hook_event_name: "SessionStart" }))).not.toContain(
    "team knowledge (",
  );
}

describe("team scope fails closed", () => {
  it("shares when scope.json lists the repository (control)", () => {
    const repo = teamAndRepo(JSON.stringify({ projects: ["github.com/acme-analytics/*"] }));
    expect(teamScope(repo).inScope).toBe(true);
    expect(loadTeam(repo).items.map((i) => i.id)).toEqual(["c1"]);
  });

  it("shares nothing while scope.json is only partly synced", () => {
    const whole = JSON.stringify({ projects: ["github.com/acme-analytics/*"] });
    const repo = teamAndRepo(whole.slice(0, whole.length - 6));
    expect(teamScope(repo).reason).toContain("scope.json is invalid");
    sharesNothing(repo);
  });

  it("shares nothing when the snapshot itself is damaged", () => {
    const repo = teamAndRepo(JSON.stringify({ projects: ["github.com/acme-analytics/*"] }));
    writeFileSync(join(dataDir(), "team-snapshot.json"), '{"dir": "');
    sharesNothing(repo);
  });

  it("forgets a selection it can no longer read instead of guessing", () => {
    const repo = teamAndRepo();
    setSelected(repo, true);
    expect(teamScope(repo).inScope).toBe(true);
    writeFileSync(join(dataDir(), "config.json"), '{"projects": [{"root": ');
    sharesNothing(repo);
  });

  it("skips a team file cut off mid-sync and keeps loading the rest", () => {
    const repo = teamAndRepo(JSON.stringify({ projects: ["github.com/acme-analytics/*"] }));
    writeFileSync(
      join(process.env.ENGRAM_TEAM_DIR!, "caveats", "b.md"),
      "---\nid: c2\ntitle: Half wr",
    );
    refreshSnapshot(0);
    const { items, skipped } = loadTeam(repo);
    expect(items.map((i) => i.id)).toEqual(["c1"]);
    expect(skipped.map((s) => s.path)).toEqual([
      join(process.env.ENGRAM_TEAM_DIR!, "caveats", "b.md"),
    ]);
  });
});

describe("hook arrival order (verified behavior)", () => {
  const failed = (work: string) =>
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "bq query 'SELECT signup_dt FROM analytics.dim_users'" },
        error: "Unrecognized name: signup_dt",
      }),
    );
  const worked = (work: string) =>
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "bq query 'SELECT signup_date FROM analytics.dim_users'" },
      }),
    );

  // Pairing follows the order hooks append records, which is the order of sequential tool calls.
  // When the success's async hook lands first (parallel tool calls), no fix is made: a hook
  // payload carries no time of the call, so the order cannot be recovered afterwards.
  it("pairs a failure followed by its fix", () => {
    const { work } = sandbox();
    failed(work);
    worked(work);
    expect(allNotes().filter((n) => n.kind === "fix").length).toBe(1);
  });

  it("makes no fix when the success arrives first, and keeps both records", () => {
    const { work } = sandbox();
    worked(work);
    failed(work);
    expect(allNotes().filter((n) => n.kind === "fix")).toEqual([]);
    expect(projectObservations(projectId(work)).length).toBe(2);
  });
});

describe("MCP results (engram's handling)", () => {
  // A call Claude Code reports as failed arrives as PostToolUseFailure. A call that arrives as
  // PostToolUse is kept as a success whatever its result says, because engram never reads
  // tool_response. Which event real servers' error results arrive as was not checked here.
  it("keeps an MCP call that reported an error in its result as a success, and stores no response", () => {
    const { work } = sandbox();
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__bigquery__execute_sql",
        tool_input: { sql: "SELECT signup_dt FROM analytics.dim_users" },
        tool_response: {
          isError: true,
          content: [
            {
              type: "text",
              text: '{"error": "Unrecognized name: signup_dt", "rows": "alice@example.com"}',
            },
          ],
        },
      }),
    );
    const [o] = projectObservations(projectId(work));
    expect(o.input).toBe("SELECT signup_dt FROM analytics.dim_users");
    expect(o.error).toBeUndefined();
    expect(JSON.stringify(o)).not.toContain("alice");
  });

  it("records the error of an MCP call sent as a failure", () => {
    const { work } = sandbox();
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUseFailure",
        tool_name: "mcp__bigquery__execute_sql",
        tool_input: { sql: "SELECT signup_dt FROM analytics.dim_users" },
        error: "Unrecognized name: signup_dt",
      }),
    );
    expect(projectObservations(projectId(work))[0].error).toBe("Unrecognized name: signup_dt");
  });
});
