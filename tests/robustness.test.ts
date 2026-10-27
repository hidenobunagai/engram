import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { extractTables, isTrivial, onPrompt, onSessionStart, onStop } from "../src/hooks";
import {
  allNotes,
  compactNotes,
  dataDir,
  forget,
  hookErrors,
  logHookError,
  projectId,
  readRecap,
  rewriteStores,
  saveNote,
  updateRecap,
} from "../src/memory";
import { search, tokenize } from "../src/search";
import { loadTeam, readSnapshot, refreshSnapshot, teamScope, writeTeamItem } from "../src/team";
import { sandbox } from "./helpers";

const ev = (work: string, session: string, extra: object) =>
  ({ session_id: session, cwd: work, ...extra }) as any;

const noteLines = () =>
  readFileSync(join(dataDir(), "notes.jsonl"), "utf-8").split("\n").filter(Boolean);

describe("full-width input (NFKC)", () => {
  it("tokenizes full-width ASCII like its half-width form", () => {
    expect(tokenize("ｄｉｍ＿ｕｓｅｒｓ")).toEqual(tokenize("dim_users"));
    expect(tokenize("ＳＥＬＥＣＴ ｓｉｇｎｕｐ＿ｄａｔｅ")).toEqual(tokenize("SELECT signup_date"));
    // Half-width katakana makes the same bigrams as full-width.
    expect(tokenize("ｳﾘｱｹﾞ")).toEqual(tokenize("ウリアゲ"));
  });

  it("finds a stored full-width doc from a half-width query", () => {
    const docs = [
      {
        id: "n1",
        source: "note" as const,
        kind: "caveat",
        title: "ｆｃｔ＿ｏｒｄｅｒｓ",
        text: "返品を含む",
        ts: 0,
        weight: 1,
      },
    ];
    expect(search(docs, "fct_orders", 5, 0).map((h) => h.doc.id)).toEqual(["n1"]);
  });

  it("injects a half-width note for a prompt typed in full-width", () => {
    const { work } = sandbox();
    saveNote({
      project: projectId(work),
      kind: "caveat",
      title: "dim_users keeps soft-deleted rows",
      body: "Filter deleted_at IS NULL.",
      tables: ["analytics.dim_users"],
    });
    const ctx = onPrompt(
      ev(work, "s1", {
        hook_event_name: "UserPromptSubmit",
        prompt: "ｄｉｍ＿ｕｓｅｒｓ の件数を国別に",
      }),
    );
    expect(ctx).toContain("dim_users keeps soft-deleted rows");
  });
});

describe("prompt budget in bytes", () => {
  it("keeps a Japanese-heavy injection within 1500 UTF-8 bytes", () => {
    const { work } = sandbox();
    for (let i = 0; i < 5; i++)
      saveNote({
        project: projectId(work),
        kind: "caveat",
        title: `売上テーブルの注意点その${i}`,
        body: `${i}番目：${"売上金額は税込で、返品は翌月に計上される。キャンセル分は別テーブルに入る。".repeat(4)}`,
        tables: ["fct_sales"],
      });
    const ctx = onPrompt(
      ev(work, "s1", {
        hook_event_name: "UserPromptSubmit",
        prompt: "fct_sales の売上を月別に集計して",
      }),
    );
    expect(ctx.split("\n").length).toBeGreaterThan(1);
    // Counting characters let this block reach about 3 KB.
    expect(ctx.length).toBeLessThan(1500);
    expect(Buffer.byteLength(ctx)).toBeLessThanOrEqual(1500);
  });
});

describe("hook error log", () => {
  it("lists entries with their time and first line", () => {
    sandbox();
    expect(hookErrors()).toEqual([]);
    logHookError(new Error("boom one"));
    logHookError("plain text failure");
    const errors = hookErrors();
    expect(errors.map((e) => e.message)).toEqual(["Error: boom one", "plain text failure"]);
    expect(Date.now() - errors[1].ts).toBeLessThan(60_000);
  });

  it("caps the log at 256 KB, keeping the newest entries whole", () => {
    sandbox();
    const stack = "x".repeat(1000);
    for (let i = 0; i < 400; i++) logHookError(`failure ${i}\n${stack}`);
    const file = join(dataDir(), "error.log");
    expect(readFileSync(file).length).toBeLessThanOrEqual(256 * 1024);
    const errors = hookErrors();
    expect(errors[errors.length - 1].message).toBe("failure 399");
    // The file starts at an entry, not halfway through a stack.
    expect(readFileSync(file, "utf-8")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(errors.length).toBeLessThan(400);
  });
});

describe("launcher-run commands", () => {
  it("does not capture engram's own commands run through run-hook.sh", () => {
    const cmd = 'sh "/home/u/.claude/plugins/engram/hooks/run-hook.sh" recall "dim_users"';
    expect(isTrivial({ tool_name: "Bash" } as any, cmd)).toBe(true);
  });
});

describe("per-session recaps", () => {
  it("keeps both recaps when two sessions run in one project", () => {
    const { work } = sandbox();
    const project = projectId(work);
    updateRecap(project, "s1", { firstPrompt: "first session work" });
    updateRecap(project, "s2", { firstPrompt: "second session work" });
    expect(readRecap(project, "s2")?.firstPrompt).toBe("first session work");
    expect(readRecap(project, "s1")?.firstPrompt).toBe("second session work");
    expect(readRecap(project)?.session).toBe("s2");
    // Written through a temp file: nothing is left beside the recaps.
    const dir = join(dataDir(), "recaps", project);
    expect(readdirSync(dir).sort()).toEqual(["s1.json", "s2.json"]);
  });

  it("shows another session's recap at start, never the session's own", () => {
    const { work } = sandbox();
    onStop(
      ev(work, "s1", { hook_event_name: "Stop", last_assistant_message: "Built the funnel." }),
    );
    onStop(ev(work, "s2", { hook_event_name: "Stop", last_assistant_message: "Fixed churn." }));
    const start = onSessionStart(ev(work, "s2", { hook_event_name: "SessionStart" }));
    expect(start).toContain("Built the funnel.");
    expect(start).not.toContain("Fixed churn.");
  });

  it("still reads a recap written by an older version", () => {
    const { work } = sandbox();
    const project = projectId(work);
    mkdirSync(join(dataDir(), "recaps"), { recursive: true });
    writeFileSync(
      join(dataDir(), "recaps", `${project}.json`),
      JSON.stringify({ session: "old", project, ts: 5, firstPrompt: "legacy recap" }),
    );
    expect(readRecap(project, "s9")?.firstPrompt).toBe("legacy recap");
  });

  it("purge deletes a matching recap instead of keeping it", () => {
    const { work } = sandbox();
    const project = projectId(work);
    updateRecap(project, "s1", { firstPrompt: "token leaked-marker-123" });
    const report = rewriteStores((text) => (/leaked-marker/.test(text) ? null : text));
    expect(report.recaps).toBe(1);
    expect(readRecap(project)).toBeNull();
  });
});

describe("notes.jsonl compaction", () => {
  const save = (work: string, body: string) =>
    saveNote({ project: projectId(work), kind: "caveat", title: "t", body });

  it("rewrites the file once superseded lines outnumber live notes", () => {
    const { work } = sandbox();
    for (let i = 0; i < 4; i++) save(work, "same body");
    save(work, "other body");
    expect(noteLines().length).toBe(5);
    expect(compactNotes()).toBe(true);
    expect(noteLines().length).toBe(2);
    expect(
      allNotes()
        .map((n) => n.body)
        .sort(),
    ).toEqual(["other body", "same body"]);
    expect(compactNotes()).toBe(false);
  });

  it("leaves a mostly-live file alone unless forced", () => {
    const { work } = sandbox();
    save(work, "a");
    save(work, "a");
    save(work, "b");
    save(work, "c");
    expect(compactNotes()).toBe(false);
    expect(compactNotes(true)).toBe(true);
    expect(noteLines().length).toBe(3);
  });

  it("forget leaves only live notes on disk", () => {
    const { work } = sandbox();
    const a = save(work, "a");
    save(work, "a");
    save(work, "b");
    forget(a.id);
    expect(noteLines().length).toBe(1);
    expect(noteLines()[0]).toContain('"body":"b"');
  });

  it("runs at session start", () => {
    const { work } = sandbox();
    for (let i = 0; i < 4; i++) save(work, "same");
    onSessionStart(ev(work, "s1", { hook_event_name: "SessionStart" }));
    expect(noteLines().length).toBe(1);
  });
});

describe("team writes", () => {
  const item = (id: string) => ({
    id,
    kind: "caveat" as const,
    title: "Orders double count",
    tables: [],
    tags: [],
    body: `body of ${id}`,
  });

  it.skipIf(process.platform === "win32")(
    "takes the next suffix when a file appears at the planned path",
    () => {
      const { work } = sandbox();
      const base = join(work, "shared");
      mkdirSync(join(base, "caveats"), { recursive: true });
      // A dangling link is invisible to existsSync but taken for an exclusive create: the same
      // state as a teammate's file landing between planning and writing.
      symlinkSync(join(work, "nowhere"), join(base, "caveats", "orders-double-count.md"));
      const path = writeTeamItem(base, item("c1"));
      expect(path).toBe(join(base, "caveats", "orders-double-count-2.md"));
      expect(readFileSync(path, "utf-8")).toContain("body of c1");
    },
  );

  it("replaces the file holding the same id in place", () => {
    const { work } = sandbox();
    const base = join(work, "shared");
    const first = writeTeamItem(base, item("c1"));
    const again = writeTeamItem(base, { ...item("c1"), body: "updated" });
    expect(again).toBe(first);
    expect(readFileSync(first, "utf-8")).toContain("updated");
    expect(readdirSync(join(base, "caveats"))).toEqual(["orders-double-count.md"]);
  });
});

describe("snapshot lock", () => {
  const lockFile = () => join(dataDir(), "team-snapshot.json.lock");
  const teamWithItem = (team: string) => {
    mkdirSync(join(team, "caveats"), { recursive: true });
    writeFileSync(join(team, "caveats", "a.md"), "---\nid: a\ntitle: A\n---\nbody");
  };

  it("a forced refresh reads the folder but keeps another process's live lock", () => {
    sandbox();
    teamWithItem(process.env.ENGRAM_TEAM_DIR!);
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(lockFile(), "99999");
    const { snap, error } = refreshSnapshot(0);
    expect(error).toBeUndefined();
    expect(snap?.items.map((i) => i.id)).toEqual(["a"]);
    expect(existsSync(lockFile())).toBe(true);
  });

  it("a cached refresh waits for a live lock but takes over a stale one", () => {
    sandbox();
    teamWithItem(process.env.ENGRAM_TEAM_DIR!);
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(lockFile(), "99999");
    expect(refreshSnapshot(60_000).snap).toBeNull();
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockFile(), old, old);
    expect(refreshSnapshot(60_000).snap?.items.length).toBe(1);
    expect(existsSync(lockFile())).toBe(false);
    expect(readSnapshot()?.items.length).toBe(1);
  });

  it("a negative TTL behaves like a forced refresh and releases its own lock", () => {
    sandbox();
    teamWithItem(process.env.ENGRAM_TEAM_DIR!);
    expect(refreshSnapshot(-5).snap?.items.length).toBe(1);
    expect(existsSync(lockFile())).toBe(false);
  });
});

describe("extractTables", () => {
  it("captures every table of a comma-separated FROM list", () => {
    expect(
      extractTables("SELECT * FROM orders, customers WHERE orders.cid = customers.id"),
    ).toEqual(["orders", "customers"]);
    expect(
      extractTables("SELECT * FROM sales.orders o, `p.d.items` AS i, users u WHERE o.x IN (1, 2)"),
    ).toEqual(["sales.orders", "p.d.items", "users"]);
  });

  it("leaves out names a WITH clause defines", () => {
    expect(
      extractTables(
        "WITH recent AS (SELECT * FROM events), totals AS MATERIALIZED (SELECT * FROM recent) " +
          "SELECT * FROM totals JOIN dim_users u ON u.id = totals.id",
      ),
    ).toEqual(["events", "dim_users"]);
    expect(
      extractTables("WITH RECURSIVE tree AS (SELECT * FROM nodes) SELECT * FROM tree"),
    ).toEqual(["nodes"]);
  });

  it("does not take Python imports or FROM inside a function for tables", () => {
    expect(extractTables("from pandas import read_sql\nfrom google.cloud import bigquery")).toEqual(
      [],
    );
    expect(
      extractTables("SELECT EXTRACT(year FROM created_at), TRIM(x FROM y) FROM orders"),
    ).toEqual(["orders"]);
  });

  it("does not take a keyword after a table for an alias", () => {
    expect(extractTables("SELECT * FROM t1 JOIN t2 USING (id) WHERE a, b")).toEqual(["t1", "t2"]);
    expect(extractTables("SELECT * FROM t1 LEFT JOIN t2 ON t1.id = t2.id")).toEqual(["t1", "t2"]);
  });
});

describe("a cloned repository's .engram/ folder", () => {
  const clone = (work: string) => {
    mkdirSync(join(work, ".git"), { recursive: true });
    mkdirSync(join(work, ".engram", "caveats"), { recursive: true });
    writeFileSync(
      join(work, ".engram", "caveats", "x.md"),
      "---\nid: repo-x\ntitle: Repo caveat on dim_users\ntarget_tables: [dim_users]\n---\nbody",
    );
  };

  it("joins the team scope and is injected by default", () => {
    const { work } = sandbox();
    clone(work);
    expect(loadTeam(work).items.map((i) => i.id)).toEqual(["repo-x"]);
    expect(teamScope(work).reason).toBe("project has a .engram/ folder");
  });

  it("is ignored once the repository has a .engram-ignore file", () => {
    const { work } = sandbox();
    clone(work);
    writeFileSync(join(work, ".engram-ignore"), "");
    expect(loadTeam(work).items).toEqual([]);
    expect(teamScope(work).reason).not.toBe("project has a .engram/ folder");
  });
});
