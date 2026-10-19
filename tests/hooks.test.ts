import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  errorHeadline,
  extractTables,
  onPrompt,
  onSessionStart,
  onStop,
  onToolUse,
} from "../src/hooks";
import {
  allNotes,
  forget,
  pathKey,
  projectId,
  projectIdOfRoot,
  projectObservations,
  saveNote,
} from "../src/memory";
import { joinTeam, sandbox } from "./helpers";

const ev = (work: string, session: string, extra: object) =>
  ({ session_id: session, cwd: work, ...extra }) as any;

describe("hooks", () => {
  it("captures commands, redacts secrets, skips trivial ones, never stores output", () => {
    const { work } = sandbox();
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      }),
    );
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "psql postgresql://u:hunter2@db/x -c 'select 1'" },
        tool_response: { stdout: "customer@example.com" },
      }),
    );
    const obs = projectObservations(projectId(work));
    expect(obs.length).toBe(1);
    expect(JSON.stringify(obs)).not.toContain("hunter2");
    expect(JSON.stringify(obs)).not.toContain("customer@example.com");
  });

  it("turns an error followed by a working command into a fix note", () => {
    const { work } = sandbox();
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "bq query 'SELECT signup_dt FROM analytics.dim_users'" },
        error: "Exit code 1\nUnrecognized name: signup_dt",
      }),
    );
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "bq query 'SELECT signup_date FROM analytics.dim_users'" },
      }),
    );
    const fixes = allNotes().filter((n) => n.kind === "fix");
    expect(fixes.length).toBe(1);
    expect(fixes[0].title).toBe("Fix: Unrecognized name: signup_dt");
    expect(fixes[0].tables).toEqual(["analytics.dim_users"]);
    // A second success must not pair the same error again.
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "bq query 'SELECT 2 FROM analytics.dim_users'" },
      }),
    );
    expect(allNotes().filter((n) => n.kind === "fix").length).toBe(1);
  });

  it("recalls the fix in a later session and shows a recap", () => {
    const { work } = sandbox();
    onPrompt(ev(work, "s1", { prompt: "dim_users のサインアップ日で集計して" }));
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "bq query 'SELECT signup_dt FROM analytics.dim_users'" },
        error: "Unrecognized name: signup_dt",
      }),
    );
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "bq query 'SELECT signup_date FROM analytics.dim_users'" },
      }),
    );
    onStop(ev(work, "s1", { last_assistant_message: "Monthly signups are in the table above." }));

    const start = onSessionStart(ev(work, "s2", { source: "startup" }));
    expect(start).toContain("dim_users のサインアップ日で集計して");
    expect(start).toContain("Monthly signups");

    const ctx = onPrompt(ev(work, "s2", { prompt: "dim_users から月次の登録数を出して" }));
    expect(ctx).toContain("Fix: Unrecognized name: signup_dt");
    expect(ctx.length).toBeLessThanOrEqual(1500);
    expect(onPrompt(ev(work, "s2", { prompt: "make the chart title bigger" }))).toBe("");
  });

  it("indexes team knowledge at session start", () => {
    const { work } = sandbox();
    const team = process.env.ENGRAM_TEAM_DIR!;
    mkdirSync(join(team, "caveats"), { recursive: true });
    writeFileSync(
      join(team, "caveats", "a.md"),
      '---\nid: c1\ntitle: Soft deletes\ntarget_tables: ["dim_users"]\n---\n### Problem\nDeleted users stay in the table.',
    );
    joinTeam(work);
    expect(onSessionStart(ev(work, "s1", { source: "startup" }))).toContain(
      "caveat: Soft deletes [dim_users] — Deleted users stay in the table.",
    );
  });

  it("picks the useful error line", () => {
    expect(
      errorHeadline(
        "Exit code 1\nTraceback (most recent call last):\n  File x\nsqlite3.OperationalError: no such column: signup_dt",
      ),
    ).toBe("sqlite3.OperationalError: no such column: signup_dt");
    expect(
      errorHeadline("Exit code 2\nBigQuery error in query operation: Unrecognized name: x\nmore"),
    ).toBe("BigQuery error in query operation: Unrecognized name: x");
  });

  it("extracts table names", () => {
    expect(extractTables("select * from `proj.ds.t1` a join ds.t2 on x left join t3")).toEqual([
      "proj.ds.t1",
      "ds.t2",
      "t3",
    ]);
  });
});

describe("review regressions", () => {
  const bash = (work: string, session: string, command: string, error?: string) =>
    onToolUse(
      ev(work, session, {
        hook_event_name: error ? "PostToolUseFailure" : "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        error,
      }),
    );

  it("session start survives stray files under obs/", () => {
    const { home, work } = sandbox();
    mkdirSync(join(home, "obs"), { recursive: true });
    writeFileSync(join(home, "obs", ".DS_Store"), "x");
    expect(onSessionStart(ev(work, "s1", { source: "startup" }))).toContain("personal memory");
  });

  it("captures only SQL-like fields from MCP tools", () => {
    const { work } = sandbox();
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__claude_ai_Google_Sheets__append_values",
        tool_input: { spreadsheetId: "x", values: [["Taro", "taro@x.jp"]] },
      }),
    );
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__bigquery__execute_sql",
        tool_input: { projectId: "p", sql: "select count(*) from analytics.dim_users" },
      }),
    );
    expect(projectObservations(projectId(work)).map((o) => [o.tool, o.input])).toEqual([
      ["mcp__bigquery__execute_sql", "select count(*) from analytics.dim_users"],
    ]);
  });

  it("captures chained commands that start with a trivial word", () => {
    const { work } = sandbox();
    bash(work, "s1", "cd /x && bq query 'select 1 from t'");
    bash(work, "s1", "cd /x && ls");
    expect(projectObservations(projectId(work)).map((o) => o.input)).toEqual([
      "cd /x && bq query 'select 1 from t'",
    ]);
  });

  it("pairs one error at most once even with an unrelated success in between", () => {
    const { work } = sandbox();
    bash(work, "s1", 'bq query "select user_id from dim_users"', "Unrecognized name: signup_dt");
    bash(work, "s1", "dbt run --select dim_users user_id");
    bash(work, "s1", 'bq query "select user_id from fct_orders"');
    expect(allNotes().filter((n) => n.kind === "fix").length).toBe(1);
  });

  it("keeps each session's first prompt when sessions interleave", () => {
    const { work } = sandbox();
    onPrompt(ev(work, "A", { prompt: "first A: monthly churn by plan" }));
    onPrompt(ev(work, "B", { prompt: "B: unrelated refactor of auth" }));
    onPrompt(ev(work, "A", { prompt: "A2: now add the retention cohort" }));
    expect(onSessionStart(ev(work, "C", { source: "startup" }))).toContain(
      "started with: first A: monthly churn by plan",
    );
  });

  it("does not glue a new note onto a torn line", () => {
    const { home } = sandbox();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "notes.jsonl"), '{"t":"note","id":"half"');
    saveNote({ project: "p", kind: "note", title: "after crash", body: "b" });
    expect(allNotes().map((n) => n.title)).toEqual(["after crash"]);
  });

  it("forget erases the note from disk", () => {
    const { home } = sandbox();
    const n = saveNote({ project: "p", kind: "fact", title: "t", body: "VIP note zzsecretzz" });
    forget(n.id);
    expect(readFileSync(join(home, "notes.jsonl"), "utf-8")).not.toContain("zzsecretzz");
  });

  it("reports skipped team files without a dangling header", () => {
    const { work } = sandbox();
    const team = process.env.ENGRAM_TEAM_DIR!;
    mkdirSync(join(team, "caveats"), { recursive: true });
    writeFileSync(join(team, "caveats", "bad.md"), "no frontmatter");
    joinTeam(work);
    expect(onSessionStart(ev(work, "s1", { source: "startup" }))).toMatch(
      /^engram: 1 team file\(s\) skipped/,
    );
  });

  it("does not pair bq query failure with bq ls success", () => {
    const { work } = sandbox();
    bash(
      work,
      "s1",
      "bq query 'select signup_dt from analytics.users'",
      "Unrecognized name: signup_dt",
    );
    bash(work, "s1", "bq ls analytics");
    expect(allNotes().filter((n) => n.kind === "fix").length).toBe(0);
  });

  it("does not pair unrelated python commands that only share the python command name", () => {
    const { work } = sandbox();
    bash(work, "s1", "python load.py", "FileNotFoundError: data.csv");
    bash(work, "s1", "python report.py");
    expect(allNotes().filter((n) => n.kind === "fix").length).toBe(0);
  });

  it("does not pair chained commands based on shared leading cd", () => {
    const { work } = sandbox();
    bash(
      work,
      "s1",
      "cd ~/work/kpi && bq query 'select signup_dt from analytics.users'",
      "Unrecognized name: signup_dt",
    );
    bash(work, "s1", "cd ~/work/kpi && bq ls analytics");
    expect(allNotes().filter((n) => n.kind === "fix").length).toBe(0);
  });

  it("does not let an unrelated success prevent a real fix from pairing", () => {
    const { work } = sandbox();
    bash(
      work,
      "s1",
      "bq query 'select signup_dt from analytics.users'",
      "Unrecognized name: signup_dt",
    );
    bash(work, "s1", "bq ls analytics");
    bash(work, "s1", "bq query 'select signup_date from analytics.users'");
    const fixes = allNotes().filter((n) => n.kind === "fix");
    expect(fixes.length).toBe(1);
    expect(fixes[0].body).toMatch(/Worked:\n```\nbq query 'select signup_date/);
  });

  it("pairs valid fixes even when the command name differs", () => {
    const { work } = sandbox();
    bash(work, "s1", "python load.py", "ModuleNotFoundError: No module named 'requests'");
    bash(work, "s1", "uv run python load.py");
    const fixes = allNotes().filter((n) => n.kind === "fix");
    expect(fixes.length).toBe(1);
    expect(fixes[0].body).toMatch(/Worked:\n```\nuv run python load\.py/);
  });
});

describe("file edits, history and dedupe", () => {
  it("captures SQL written to files but only the path for data files", () => {
    const { work } = sandbox();
    const fx = (name: string) =>
      JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf-8"));
    onToolUse({ ...fx("post-tool-use-write"), cwd: work });
    onToolUse({ ...fx("post-tool-use-edit"), cwd: work });
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(work, "out.csv"), content: "name,email\nTaro,t@x.jp" },
      }),
    );
    expect(
      projectObservations(projectId(work))
        .map((o) => o.input)
        .sort(),
    ).toEqual([
      "edit /work/analytics/q.sql\nselect user_id from dim_users",
      `write ${join(work, "out.csv")}`,
      "write /work/analytics/q.sql\nselect 1 from dim_users\n",
    ]);
  });

  it("does not pair failed edits as fixes", () => {
    const { work } = sandbox();
    const edit = (error?: string) =>
      onToolUse(
        ev(work, "s1", {
          hook_event_name: error ? "PostToolUseFailure" : "PostToolUse",
          tool_name: "Edit",
          tool_input: { file_path: "/w/q.sql", old_string: "a", new_string: "b" },
          error,
        }),
      );
    edit("String to replace not found");
    edit();
    expect(allNotes().length).toBe(0);
  });

  it("refreshes instead of duplicating an identical note", () => {
    sandbox();
    const a = saveNote({ project: "p", kind: "caveat", title: "T", body: "B" });
    const b = saveNote({ project: "p", kind: "caveat", title: "T", body: "B" });
    expect(b.id).toBe(a.id);
    expect(allNotes().length).toBe(1);
  });

  it("lists this project's latest notes at session start", () => {
    const { work } = sandbox();
    saveNote({
      project: projectId(work),
      kind: "caveat",
      title: "Soft deletes in dim_users",
      body: "b",
    });
    expect(onSessionStart(ev(work, "s1", { source: "startup" }))).toContain(
      "] Soft deletes in dim_users",
    );
  });
});

describe("file capture review regressions", () => {
  const write = (work: string, file: string, content: string) =>
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: file, content },
      }),
    );

  it("stores notebook code, not outputs, and skips data saved as .sql", () => {
    const { work } = sandbox();
    const nb = {
      cells: [
        {
          cell_type: "code",
          outputs: [{ data: { "image/png": "iVBOR".repeat(400) } }],
          source: ["df = spark.sql('SELECT * FROM fct_orders WHERE refund_flag = 1')"],
        },
      ],
    };
    write(work, "/w/a.ipynb", JSON.stringify(nb));
    write(
      work,
      "/w/export.sql",
      "id,name,city,score\n1,Taro Yamada,Tokyo,3\n2,Hanako Sato,Osaka,4\n",
    );
    expect(projectObservations(projectId(work)).map((o) => o.input)).toEqual([
      "write /w/a.ipynb\ndf = spark.sql('SELECT * FROM fct_orders WHERE refund_flag = 1')",
      "write /w/export.sql",
    ]);
  });

  it("shows one line per file however often it was edited", () => {
    const { work } = sandbox();
    for (let i = 0; i < 10; i++)
      onToolUse(
        ev(work, "s1", {
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          tool_input: {
            file_path: "/w/report.sql",
            old_string: "a",
            new_string: `SELECT revenue_${i} FROM fct_orders WHERE status = 'paid'`,
          },
        }),
      );
    write(work, "/w/other.sql", "SELECT refund FROM fct_orders WHERE status = 'paid'");
    const ctx = onPrompt(ev(work, "s2", { prompt: "revenue from fct_orders paid status" }));
    expect(ctx.match(/report\.sql/g)?.length).toBe(1);
    expect(ctx).toContain("other.sql");
  });
});

describe("windows path keys", () => {
  it("treats c:\\ and C:\\ as the same project on win32 only", () => {
    expect(pathKey("C:\\Users\\Me\\.claude", "win32")).toBe(
      pathKey("c:\\users\\me\\.claude\\", "win32"),
    );
    expect(projectIdOfRoot("C:\\Users\\Me\\kpi", "win32")).toBe(
      projectIdOfRoot("c:\\Users\\Me\\kpi", "win32"),
    );
    expect(projectIdOfRoot("/home/Me/kpi", "linux")).not.toBe(
      projectIdOfRoot("/home/me/kpi", "linux"),
    );
  });

  it("keeps Linux and macOS ids unchanged", () => {
    // Same formula as before the change: sha1 of the resolved root.
    const { createHash } = require("crypto");
    const root = "/home/me/kpi";
    expect(projectIdOfRoot(root, "linux")).toBe(
      `kpi-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`,
    );
  });
});
