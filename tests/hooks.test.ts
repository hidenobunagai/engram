import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  errorHeadline,
  extractTables,
  identifiers,
  matchedTables,
  onPreToolUse,
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
  readRecap,
  saveNote,
} from "../src/memory";
import { joinTeam, nextMillisecond, sandbox } from "./helpers";

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
    nextMillisecond();
    onPrompt(ev(work, "B", { prompt: "B: unrelated refactor of auth" }));
    nextMillisecond();
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

  it("does not pair two bq queries that only share the `bq query` invocation", () => {
    const { work } = sandbox();
    bash(
      work,
      "s1",
      "bq query 'SELECT country FROM analytics.dim_users'",
      "Access Denied: Table analytics.dim_users: User does not have permission to query table",
    );
    bash(work, "s1", "bq query 'SELECT signup FROM analytics.fct_orders'");
    expect(allNotes().filter((n) => n.kind === "fix").length).toBe(0);
  });

  it("does not pair two kubectl commands that only share program, flags and namespace", () => {
    const { work } = sandbox();
    bash(
      work,
      "s1",
      "kubectl --context prod-eu -n payments rollout restart deployment/api",
      'Error from server (NotFound): deployments.apps "api" not found',
    );
    bash(work, "s1", "kubectl --context prod-eu -n payments logs pod/worker-7");
    expect(allNotes().filter((n) => n.kind === "fix").length).toBe(0);
  });

  it("still pairs a fix whose payload matches beyond the invocation", () => {
    const { work } = sandbox();
    bash(
      work,
      "s1",
      "kubectl apply -f k8s/api-deployment.yaml",
      'error: error validating "k8s/api-deployment.yaml": unknown field "replica"',
    );
    bash(work, "s1", "kubectl apply --validate=false -f k8s/api-deployment.yaml");
    const fixes = allNotes().filter((n) => n.kind === "fix");
    expect(fixes.length).toBe(1);
    expect(fixes[0].body).toMatch(/Worked:\n```\nkubectl apply --validate=false/);
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
    ).toEqual(
      // Sorted too: a Windows temp path (C:\...) sorts after /work, a POSIX one (/tmp) before it.
      [
        "edit /work/analytics/q.sql\nselect user_id from dim_users",
        `write ${join(work, "out.csv")}`,
        "write /work/analytics/q.sql\nselect 1 from dim_users\n",
      ].sort(),
    );
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

  it("counts this project's notes separately from other projects'", () => {
    const { work } = sandbox();
    saveNote({ project: projectId(work), kind: "caveat", title: "Own note", body: "b" });
    saveNote({ project: "other-1", kind: "caveat", title: "Foreign one", body: "b" });
    saveNote({ project: "other-2", kind: "caveat", title: "Foreign two", body: "b" });
    const start = onSessionStart(ev(work, "s1", { source: "startup" }));
    expect(start).toContain("holds 1 saved note(s) for this project;");
    // Other projects' notes stay out of this project's prompts, and the summary says so.
    expect(start).toContain("2 from other projects stay there");
    expect(start).not.toContain("holds 3 saved note(s)");
  });

  it("stays quiet about other projects when every note belongs here", () => {
    const { work } = sandbox();
    saveNote({ project: projectId(work), kind: "caveat", title: "Own note", body: "b" });
    const start = onSessionStart(ev(work, "s1", { source: "startup" }));
    expect(start).toContain("holds 1 saved note(s) for this project;");
    expect(start).not.toContain("from other projects");
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

describe("fix pairing noise", () => {
  const run = (work: string, tool: string, input: object, error?: string) =>
    onToolUse(
      ev(work, "s1", {
        hook_event_name: error ? "PostToolUseFailure" : "PostToolUse",
        tool_name: tool,
        tool_input: input,
        error,
      }),
    );

  it("does not pair unrelated SQL that only shares a table name", () => {
    const { work } = sandbox();
    run(
      work,
      "mcp__bigquery__execute_sql",
      { sql: "SELECT signup_dt FROM analytics.dim_users" },
      "Unrecognized name: signup_dt",
    );
    run(work, "mcp__bigquery__execute_sql", {
      sql: "SELECT country, count(*) FROM analytics.dim_users GROUP BY 1",
    });
    expect(allNotes().filter((n) => n.kind === "fix")).toEqual([]);
  });

  it("pairs the same query once the blamed column is renamed", () => {
    const { work } = sandbox();
    run(
      work,
      "mcp__bigquery__execute_sql",
      { sql: "SELECT signup_dt FROM analytics.dim_users" },
      "Unrecognized name: signup_dt",
    );
    run(work, "mcp__bigquery__execute_sql", {
      sql: "SELECT signup_date FROM analytics.dim_users",
    });
    const fixes = allNotes().filter((n) => n.kind === "fix");
    expect(fixes.length).toBe(1);
    expect(fixes[0].title).toBe("Fix: Unrecognized name: signup_dt");
  });

  it("ignores quoted and backticked identifiers in the error", () => {
    const { work } = sandbox();
    run(
      work,
      "mcp__bigquery__execute_sql",
      { sql: 'SELECT "signup_dt" FROM analytics.dim_users' },
      'Unrecognized name: "signup_dt"',
    );
    run(work, "mcp__bigquery__execute_sql", {
      sql: "SELECT country FROM analytics.dim_users GROUP BY country",
    });
    expect(allNotes().filter((n) => n.kind === "fix")).toEqual([]);
  });

  it("does not pair when the headline only carries an exit code", () => {
    const { work } = sandbox();
    run(work, "Bash", { command: "grep -rn signup_dt src/" }, "Exit code 1");
    run(work, "Bash", { command: "grep -rn signup_date src/" });
    expect(allNotes().filter((n) => n.kind === "fix")).toEqual([]);
  });

  it("does not pair when the headline only carries a failure count", () => {
    const { work } = sandbox();
    run(work, "Bash", { command: "dbt test --select signup_dt" }, "1 fail");
    run(work, "Bash", { command: "dbt test --select signup_date" });
    expect(allNotes().filter((n) => n.kind === "fix")).toEqual([]);
  });

  it("does not pair a retried command that never changed", () => {
    const { work } = sandbox();
    run(
      work,
      "Bash",
      { command: "python load.py --strict" },
      "Traceback (most recent call last):\nValueError: bad row",
    );
    run(work, "Bash", { command: "python load.py --strict" });
    expect(allNotes().filter((n) => n.kind === "fix")).toEqual([]);
  });

  it("names the intervening edit when an unchanged command then passes", () => {
    const { work } = sandbox();
    run(
      work,
      "Bash",
      { command: "python load.py --strict" },
      "Traceback (most recent call last):\nValueError: bad row",
    );
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/w/load.py", old_string: "a", new_string: "b" },
      }),
    );
    run(work, "Bash", { command: "python load.py --strict" });
    const fixes = allNotes().filter((n) => n.kind === "fix");
    expect(fixes.length).toBe(1);
    expect(fixes[0].title).toContain("/w/load.py");
  });

  it("keeps SQL from non-SQL MCP query fields out of memory", () => {
    const { work } = sandbox();
    run(work, "mcp__claude_ai_Gmail__search_threads", { query: "from:ceo subject:q3" });
    run(work, "mcp__custom__run", { query: "SELECT count(*) FROM analytics.dim_users" });
    run(work, "mcp__custom__run2", { statement: "delete from t" });
    expect(projectObservations(projectId(work)).map((o) => o.input)).toEqual([
      "SELECT count(*) FROM analytics.dim_users",
      "delete from t",
    ]);
  });
});

describe("results are never stored", () => {
  const stored = (work: string) =>
    projectObservations(projectId(work))
      .map((o) => o.input)
      .join("\n");

  it("omits data rows from a heredoc body but keeps the head line", () => {
    const { work } = sandbox();
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: {
          command: `cat > customers.csv <<'EOF'\nid,name,balance\n1,Alice Johnson,1200.50\n2,Bob Smith,8830.00\n3,Carol Ng,455.10\nEOF`,
        },
      }),
    );
    const text = stored(work);
    expect(text).toContain("id,name,balance");
    expect(text).toContain("[3 data rows omitted]");
    expect(text).not.toContain("Alice Johnson");
    expect(text).not.toContain("8830.00");
  });

  it("records a written .md report by path only", () => {
    const { work } = sandbox();
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: join(work, "report.md"),
          content: "# Churn\n\nAlice Johnson churned with $8,830.00 outstanding.\n",
        },
      }),
    );
    const text = stored(work);
    expect(text).toContain("report.md");
    expect(text).not.toContain("Alice Johnson");
    expect(text).not.toContain("8,830.00");
  });

  it("omits pasted data rows from a stored prompt", () => {
    const { work } = sandbox();
    onPrompt(
      ev(work, "s1", {
        hook_event_name: "UserPromptSubmit",
        prompt:
          "Compare these:\nid,name,amount\n1,Alice,1200.50\n2,Bob,8830.00\n3,Carol,455.10\nWhy?",
      }),
    );
    const text = stored(work);
    expect(text).toContain("id,name,amount");
    expect(text).toContain("[3 data rows omitted]");
    expect(text).not.toContain("Bob,8830.00");
    expect(text).toContain("Why?");
  });

  it("keeps only the first sentence of the reply in the recap", () => {
    const { work } = sandbox();
    onStop(
      ev(work, "s1", {
        hook_event_name: "Stop",
        last_assistant_message:
          "The query returned 3 rows. Alice Johnson owes $8,830.00, Bob Smith $1,200.50.",
      }),
    );
    const recap = readRecap(projectId(work));
    expect(recap?.lastReply).toBe("The query returned 3 rows.");
    expect(recap?.lastReply).not.toContain("8,830.00");
  });

  it("still stores a SQL query whose fields are comma separated", () => {
    const { work } = sandbox();
    onToolUse(
      ev(work, "s1", {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: `bq query 'SELECT id, name, amount FROM dim_users'` },
      }),
    );
    expect(stored(work)).toContain("SELECT id, name, amount FROM dim_users");
  });
  it("a .engram-ignore file stops the recap write as well", () => {
    const { work } = sandbox();
    writeFileSync(join(work, ".git"), "");
    writeFileSync(join(work, ".engram-ignore"), "");
    onStop(
      ev(work, "s1", {
        hook_event_name: "Stop",
        last_assistant_message: "The query returned 3 rows.",
      }),
    );
    expect(readRecap(projectId(work))).toBeNull();
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

describe("no re-injection within a session", () => {
  const bash = (work: string, session: string, command: string, error?: string) =>
    onToolUse(
      ev(work, session, {
        hook_event_name: error ? "PostToolUseFailure" : "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        error,
      }),
    );

  it("does not repeat a doc an earlier prompt of the session already showed", () => {
    const { work } = sandbox();
    saveNote({
      project: projectId(work),
      kind: "caveat",
      title: "fct_orders double counts refunds",
      body: "Refunded orders appear twice in fct_orders; filter status != 'refund'.",
    });
    const first = onPrompt(ev(work, "s1", { prompt: "revenue from fct_orders refunds" }));
    expect(first).toContain("fct_orders double counts refunds");
    const second = onPrompt(ev(work, "s1", { prompt: "fct_orders refunds by month" }));
    expect(second).not.toContain("fct_orders double counts refunds");
    // A new session has not seen it yet.
    expect(onPrompt(ev(work, "s2", { prompt: "fct_orders refunds by month" }))).toContain(
      "fct_orders double counts refunds",
    );
  });

  it("does not show a fix's source error next to the fix", () => {
    const { work } = sandbox();
    bash(
      work,
      "s1",
      "bq query 'SELECT signup_dt FROM analytics.dim_users'",
      "Unrecognized name: signup_dt",
    );
    bash(work, "s1", "bq query 'SELECT signup_date FROM analytics.dim_users'");
    const fix = allNotes().find((n) => n.kind === "fix")!;
    expect(fix.sources?.length).toBeGreaterThan(0);
    const ctx = onPrompt(ev(work, "s2", { prompt: "signup_dt in dim_users" }));
    expect(ctx).toContain("Fix: Unrecognized name: signup_dt");
    expect(ctx).not.toContain("[past error");
  });

  it("prunes a stale injection ledger with its session", () => {
    const { home, work } = sandbox();
    const { utimesSync, existsSync } = require("fs");
    saveNote({
      project: projectId(work),
      kind: "fact",
      title: "mart_mau is daily",
      body: "mart_mau refreshes daily.",
    });
    onPrompt(ev(work, "old", { prompt: "how fresh is mart_mau" }));
    const ledger = join(home, "obs", projectId(work), "old.injected");
    expect(existsSync(ledger)).toBe(true);
    const past = new Date(Date.now() - 200 * 86_400_000);
    utimesSync(ledger, past, past);
    utimesSync(join(home, "obs", projectId(work), "old.jsonl"), past, past);
    onSessionStart(ev(work, "new", { source: "startup" }));
    expect(existsSync(ledger)).toBe(false);
  });
});

describe("table-aware recall", () => {
  it("injects a caveat on a table the prompt names even when observations drown its IDF", () => {
    const { work } = sandbox();
    for (let i = 0; i < 30; i++)
      onToolUse(
        ev(work, `past${i % 3}`, {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: {
            command: `bq query 'SELECT country, count(*) FROM analytics.dim_users WHERE active AND day = ${i} GROUP BY country'`,
          },
        }),
      );
    saveNote({
      project: projectId(work),
      kind: "caveat",
      title: "dim_users keeps soft-deleted rows",
      body: "Deleted accounts stay in the table with deleted_at set.",
      tables: ["dim_users"],
    });
    const ctx = onPrompt(ev(work, "now", { prompt: "count active dim_users by country" }));
    expect(ctx).toContain("dim_users keeps soft-deleted rows");
    expect(ctx.split("\n").length - 1).toBeLessThanOrEqual(5);
    expect(ctx.length).toBeLessThanOrEqual(1500);
  });

  it("matches a qualified table name by its trailing parts, not by a word inside it", () => {
    const tables = ["prod.analytics.fct_events"];
    expect(matchedTables(identifiers("daily totals from fct_events"), tables)).toEqual(tables);
    expect(matchedTables(identifiers("select * from `analytics.fct_events`"), tables)).toEqual(
      tables,
    );
    expect(matchedTables(identifiers("which events matter most"), tables)).toEqual([]);
    expect(matchedTables(identifiers("SELECT 1 FROM analytics.dim_users"), ["dim_users"])).toEqual([
      "dim_users",
    ]);
  });
});

describe("recall after /compact", () => {
  const bash = (work: string, command: string, error?: string) =>
    onToolUse(
      ev(work, "s1", {
        hook_event_name: error ? "PostToolUseFailure" : "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        error,
      }),
    );

  it("brings back the session's own fixes and recent errors", () => {
    const { work } = sandbox();
    bash(
      work,
      "bq query 'SELECT signup_dt FROM analytics.dim_users'",
      "Unrecognized name: signup_dt",
    );
    bash(work, "bq query 'SELECT signup_date FROM analytics.dim_users'");
    bash(work, "python load.py --day 2026-10-01", "FileNotFoundError: exports/2026-10-01.csv");
    const ctx = onSessionStart(ev(work, "s1", { source: "compact" }));
    expect(ctx).toContain("Fix: Unrecognized name: signup_dt");
    expect(ctx).toContain("FileNotFoundError: exports/2026-10-01.csv");
    // The fixed error is already told by its fix.
    expect(ctx.match(/Unrecognized name: signup_dt/g)?.length).toBe(1);
    // A fresh session does not get another session's errors this way.
    expect(onSessionStart(ev(work, "s2", { source: "startup" }))).not.toContain(
      "FileNotFoundError",
    );
  });

  it("lets prompts after the compaction show memories again", () => {
    const { work } = sandbox();
    saveNote({
      project: projectId(work),
      kind: "metric",
      title: "MAU counts distinct user_id over 28 days",
      body: "mart_mau uses a 28-day window.",
    });
    expect(onPrompt(ev(work, "s1", { prompt: "how is mart_mau defined" }))).toContain("MAU counts");
    expect(onPrompt(ev(work, "s1", { prompt: "mart_mau window again" }))).not.toContain(
      "MAU counts",
    );
    onSessionStart(ev(work, "s1", { source: "compact" }));
    expect(onPrompt(ev(work, "s1", { prompt: "mart_mau window again" }))).toContain("MAU counts");
  });
});

describe("pre-query guard", () => {
  const pre = (work: string, tool_name: string, tool_input: object, session = "s1") =>
    onPreToolUse(ev(work, session, { hook_event_name: "PreToolUse", tool_name, tool_input }));
  const context = (out: string) => JSON.parse(out).hookSpecificOutput.additionalContext as string;

  it("leads with a fix whose bad column the query uses again", () => {
    const { work } = sandbox();
    const fail = (command: string, error?: string) =>
      onToolUse(
        ev(work, "past", {
          hook_event_name: error ? "PostToolUseFailure" : "PostToolUse",
          tool_name: "Bash",
          tool_input: { command },
          error,
        }),
      );
    fail("bq query 'SELECT signup_dt FROM analytics.dim_users'", "Unrecognized name: signup_dt");
    fail("bq query 'SELECT signup_date FROM analytics.dim_users'");
    saveNote({
      project: projectId(work),
      kind: "caveat",
      title: "dim_users keeps soft-deleted rows",
      body: "Filter deleted_at IS NULL.",
      tables: ["analytics.dim_users"],
    });
    const ctx = context(
      pre(work, "mcp__bigquery__execute_sql", {
        sql: "SELECT signup_dt, count(*) FROM `proj.analytics.dim_users` GROUP BY 1",
      }),
    );
    const lines = ctx.split("\n");
    expect(lines[1]).toContain("Fix: Unrecognized name: signup_dt");
    expect(lines[1]).toContain("this query uses signup_dt again");
    expect(ctx).toContain("dim_users keeps soft-deleted rows");
    // A query that already avoids the bad column only gets the caveat, and only once per session.
    const ok = pre(
      work,
      "Bash",
      { command: "bq query 'SELECT signup_date FROM analytics.dim_users'" },
      "s2",
    );
    expect(context(ok)).not.toContain("Fix:");
    expect(context(ok)).toContain("soft-deleted");
    expect(
      pre(work, "Bash", { command: "bq query 'SELECT 1 FROM analytics.dim_users'" }, "s2"),
    ).toBe("");
  });

  it("returns nothing for a query on other tables", () => {
    const { work } = sandbox();
    saveNote({
      project: projectId(work),
      kind: "caveat",
      title: "soft deletes",
      body: "x",
      tables: ["dim_users"],
    });
    expect(pre(work, "Bash", { command: "bq query 'SELECT * FROM analytics.fct_orders'" })).toBe(
      "",
    );
  });

  it("reads neither notes nor observations for a non-SQL command", () => {
    const { home, work } = sandbox();
    // Both stores are unreadable: touching either would throw.
    mkdirSync(join(home, "notes.jsonl"), { recursive: true });
    writeFileSync(join(home, "obs"), "not a directory");
    expect(pre(work, "Bash", { command: "python scripts/plot.py --out charts/" })).toBe("");
    expect(pre(work, "mcp__gmail__search", { query: "from:ceo report" })).toBe("");
  });

  it("never scans observations, even for SQL", () => {
    const { home, work } = sandbox();
    saveNote({
      project: projectId(work),
      kind: "caveat",
      title: "soft deletes",
      body: "x",
      tables: ["dim_users"],
    });
    writeFileSync(join(home, "obs"), "not a directory");
    expect(context(pre(work, "Bash", { command: "psql -c 'select * from dim_users'" }))).toContain(
      "soft deletes",
    );
  });
});
