import { describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Runs the built dist/cli.mjs under real Node, the way Claude Code hooks do. NODE_BIN picks another node (e.g. 18). */
const CLI = join(import.meta.dirname, "..", "dist", "cli.mjs");
const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf-8");

function env() {
  const root = mkdtempSync(join(tmpdir(), "engram-e2e-"));
  return {
    ...process.env,
    ENGRAM_HOME: join(root, "home"),
    ENGRAM_TEAM_DIR: join(root, "team"),
    ROOT: root,
  };
}

/** Hooks and commands run with the sandbox as cwd; payload cwds are rewritten to match. */
const run = (e: NodeJS.ProcessEnv, args: string[], input = "") =>
  spawnSync(process.env.NODE_BIN || "node", [CLI, ...args], {
    env: e,
    cwd: e.ROOT,
    input: input.replaceAll('"/work/analytics"', JSON.stringify(e.ROOT)),
    encoding: "utf-8",
  });

describe("node dist/cli.mjs", () => {
  // The fixture commands (echo, ls) are trivial and skipped, so only the prompt is stored.
  it("handles every captured hook payload and exits 0", () => {
    const e = env();
    for (const [name, event] of [
      ["session-start", "session-start"],
      ["user-prompt-submit", "prompt"],
      ["post-tool-use", "tool"],
      ["post-tool-use-failure", "tool"],
      ["stop", "stop"],
      ["pre-tool-use-sql", "pre-tool"],
      ["pre-tool-use-bash", "pre-tool"],
    ]) {
      const r = run(e, ["hook", event], fixture(name));
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain("Error");
    }
    expect(run(e, ["status"]).stdout).toContain(
      "captured observations for this project: 1 (errors: 0)",
    );
  });

  it("exits 0 with no output on garbage input", () => {
    const r = run(env(), ["hook", "prompt"], "not json");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const pre = run(env(), ["hook", "pre-tool"], "not json");
    expect(pre.status).toBe(0);
    expect(pre.stdout).toBe("");
  });

  it("warns about a caveat on the table a query is about to read", () => {
    const e = env();
    run(
      e,
      [
        "save",
        "--kind",
        "caveat",
        "--title",
        "dim_users keeps soft-deleted rows",
        "--tables",
        "dim_users",
      ],
      "Filter deleted_at IS NULL.",
    );
    const hit = run(e, ["hook", "pre-tool"], fixture("pre-tool-use-sql"));
    expect(hit.status).toBe(0);
    const out = JSON.parse(hit.stdout).hookSpecificOutput;
    expect(out.hookEventName).toBe("PreToolUse");
    expect(out.permissionDecision).toBeUndefined();
    expect(out.additionalContext).toContain("dim_users keeps soft-deleted rows");

    for (const name of ["pre-tool-use-other-sql", "pre-tool-use-bash"]) {
      const miss = run(e, ["hook", "pre-tool"], fixture(name));
      expect(miss.status).toBe(0);
      expect(miss.stdout).toBe("");
    }
  });

  it("saves, recalls, and forgets a note", () => {
    const e = env();
    const saved = run(
      e,
      [
        "save",
        "--kind",
        "caveat",
        "--title",
        "fct_orders has test orders",
        "--tables",
        "fct_orders",
      ],
      "Exclude is_test = true.",
    );
    const id = saved.stdout.match(/caveat (\S+):/)![1];
    expect(run(e, ["recall", "fct_orders"]).stdout).toContain("Exclude is_test = true.");
    run(e, ["forget", id]);
    expect(run(e, ["recall", "fct_orders"]).stdout).toContain("No memory");
  });

  it("keeps every record when hooks run in parallel", async () => {
    const e = env();
    const N = 24;
    await Promise.all(
      Array.from(
        { length: N },
        (_, i) =>
          new Promise<void>((done) => {
            const p = spawn(process.env.NODE_BIN || "node", [CLI, "hook", "tool"], {
              env: e,
              cwd: e.ROOT,
            });
            p.on("close", () => done());
            p.stdin.end(
              JSON.stringify({
                session_id: "par",
                cwd: e.ROOT,
                hook_event_name: "PostToolUse",
                tool_name: "Bash",
                tool_input: { command: `bq query 'select ${i} from t${i}'` },
              }),
            );
          }),
      ),
    );
    expect(run(e, ["status"], "").stdout).toContain(`observations for this project: ${N} `);
  }, 30_000);
});

describe("cli arguments", () => {
  it("keeps a --body that starts with an SQL comment", () => {
    const e = env();
    run(e, [
      "save",
      "--kind",
      "query",
      "--title",
      "Top users",
      "--body",
      "-- top 10\nselect 1 from dim_users",
    ]);
    expect(run(e, ["recall", "Top users"]).stdout).toContain("-- top 10");
  });
});

describe("history and scoped share", () => {
  it("lists sessions and shows a day's timeline", () => {
    const e = env();
    run(e, ["hook", "prompt"], fixture("user-prompt-submit"));
    run(e, ["hook", "tool"], fixture("post-tool-use-write"));
    const list = run(e, ["history"]).stdout;
    expect(list).toContain("11111111");
    expect(list).toContain("2 records");
    // bun test runs in UTC; take the day from the CLI's own (local-time) listing instead.
    const today = list.match(/\d{4}-\d{2}-\d{2}/)![0];
    expect(run(e, ["history", today]).stdout).toContain("Write: write /work/analytics/q.sql");
  });

  it("refuses to share notes saved outside the scope", () => {
    const e = env();
    mkdirSync(e.ENGRAM_TEAM_DIR!, { recursive: true });
    writeFileSync(
      join(e.ENGRAM_TEAM_DIR!, "scope.json"),
      '{"projects":["github.com/acme-analytics/*"]}',
    );
    const saved = run(e, ["save", "--kind", "fact", "--title", "zsh alias", "--body", "alias ll"]);
    expect(saved.stdout).toContain("personal only");
    const id = saved.stdout.match(/fact (\S+):/)![1];
    expect(run(e, ["share"]).stdout).toContain("No shareable notes");
    const r = run(e, ["share", id]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("outside the team scope");
  });
});

describe("share re-checks scope", () => {
  it("does not share notes saved before scope.json existed, or reused from another project", () => {
    const e = env();
    const dot = join(e.ROOT!, "dotfiles");
    const kpi = join(e.ROOT!, "kpi");
    for (const [d, url] of [
      [dot, "git@github.com:me/dotfiles.git"],
      [kpi, "git@github.com:acme-analytics/kpi.git"],
    ]) {
      mkdirSync(join(d, ".git"), { recursive: true });
      writeFileSync(join(d, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
    }
    const at = (cwd: string, args: string[]) =>
      spawnSync("node", [CLI, ...args], { env: e, cwd, encoding: "utf-8" });
    mkdirSync(e.ENGRAM_TEAM_DIR!, { recursive: true });
    const early = at(dot, [
      "save",
      "--kind",
      "fact",
      "--title",
      "Personal shortcut",
      "--body",
      "x",
    ]).stdout.match(/fact (\S+):/)![1];
    writeFileSync(
      join(e.ENGRAM_TEAM_DIR!, "scope.json"),
      '{"projects":["github.com/acme-analytics/*"]}',
    );
    const metric = at(kpi, [
      "save",
      "--kind",
      "metric",
      "--title",
      "Active users",
      "--body",
      "DAU",
    ]).stdout.match(/metric (\S+):/)![1];
    const again = at(dot, ["save", "--kind", "metric", "--title", "Active users", "--body", "DAU"]);
    expect(again.stdout).toContain("personal only");
    expect(again.stdout).not.toContain(metric);
    const list = at(dot, ["share"]).stdout;
    expect(list).toContain(metric);
    expect(list).not.toContain(early);
    expect(at(dot, ["share", early]).status).toBe(1);
  });
});

describe("scope paths", () => {
  // bun caches os.homedir(), so ~ expansion is checked under real Node with HOME set.
  it("expands Windows-style ~ patterns", () => {
    const e = env();
    const home = join(e.ROOT!, "home");
    const proj = join(home, "work", "acme", "kpi");
    mkdirSync(proj, { recursive: true });
    mkdirSync(e.ENGRAM_TEAM_DIR!, { recursive: true });
    writeFileSync(
      join(e.ENGRAM_TEAM_DIR!, "scope.json"),
      JSON.stringify({ paths: ["~\\work\\acme\\*"] }),
    );
    const r = spawnSync("node", [CLI, "status"], {
      env: { ...e, HOME: home, USERPROFILE: home },
      cwd: proj,
      encoding: "utf-8",
    });
    expect(r.stdout).toContain("team scope: in scope");
  });
});

describe("shared folder workflow", () => {
  it("persists the plugin option, selects a project, previews and publishes", () => {
    const e = env();
    const share = join(e.ROOT!, "S-drive", "analytics", "engram");
    mkdirSync(share, { recursive: true });
    const base = { ...e, ENGRAM_TEAM_DIR: "" };
    // Hooks receive the option from Claude Code; the session-start hook remembers it for the CLI.
    const hook = spawnSync("node", [CLI, "hook", "session-start"], {
      env: { ...base, CLAUDE_PLUGIN_ROOT: "/plugin", CLAUDE_PLUGIN_OPTION_TEAM_DIR: share },
      cwd: e.ROOT,
      input: JSON.stringify({
        session_id: "s1",
        cwd: e.ROOT,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
      encoding: "utf-8",
    });
    expect(hook.status).toBe(0);
    const at = (args: string[]) =>
      spawnSync("node", [CLI, ...args], { env: base, cwd: e.ROOT, encoding: "utf-8" });
    expect(at(["status"]).stdout).toContain(`team folder: ${share}`);
    expect(at(["scope"]).stdout).toContain("out of team scope");
    expect(at(["scope", "on"]).stdout).toContain("in team scope (selected with /engram:scope on)");
    const id = at([
      "save",
      "--kind",
      "caveat",
      "--title",
      "Refunds",
      "--body",
      "Exclude refund_flag",
    ]).stdout.match(/caveat (\S+):/)![1];
    const preview = at(["share", id]).stdout;
    expect(preview).toContain("Preview (nothing written yet)");
    expect(existsSync(join(share, "caveats"))).toBe(false);
    expect(at(["share", id, "--yes"]).stdout).toContain(join(share, "caveats", "refunds.md"));
    expect(at(["recall", "refund_flag"]).stdout).toContain("[team caveat] Refunds");
  });
});

describe("shared folder review regressions", () => {
  function setup() {
    const e = env();
    const share = join(e.ROOT!, "share");
    mkdirSync(share, { recursive: true });
    const base = { ...e, ENGRAM_TEAM_DIR: "" };
    const hook = (opt: string) =>
      spawnSync("node", [CLI, "hook", "refresh"], {
        env: { ...base, CLAUDE_PLUGIN_ROOT: "/plugin", CLAUDE_PLUGIN_OPTION_TEAM_DIR: opt },
        cwd: e.ROOT,
        input: "{}",
        encoding: "utf-8",
      });
    const at = (args: string[], cwd = e.ROOT!) =>
      spawnSync("node", [CLI, ...args], { env: base, cwd, encoding: "utf-8" });
    return { e, share, hook, at };
  }

  it("clearing the plugin option turns team sharing off", () => {
    const { share, hook, at } = setup();
    hook(share);
    expect(at(["status"]).stdout).toContain(`team folder: ${share}`);
    hook("");
    expect(at(["status"]).stdout).toContain("team folder: none");
  });

  it("selections belong to one team folder", () => {
    const { e, share, hook, at } = setup();
    hook(share);
    at(["scope", "on"]);
    const other = join(e.ROOT!, "other-team");
    mkdirSync(other);
    hook(other);
    expect(at(["scope"]).stdout).toContain("out of team scope");
  });

  it("parallel scope changes are not lost", async () => {
    const { e, share, hook } = setup();
    hook(share);
    const dirs = Array.from({ length: 12 }, (_, i) => {
      const d = join(e.ROOT!, `r${i}`);
      mkdirSync(join(d, ".git"), { recursive: true });
      return d;
    });
    await Promise.all(
      dirs.map(
        (d) =>
          new Promise<void>((done) =>
            spawn("node", [CLI, "scope", "on"], { env: { ...e, ENGRAM_TEAM_DIR: "" }, cwd: d }).on(
              "close",
              () => done(),
            ),
          ),
      ),
    );
    const cfg = JSON.parse(readFileSync(join(e.ENGRAM_HOME!, "config.json"), "utf-8"));
    expect(cfg.projects.length).toBe(12);
  }, 30_000);

  it("does not silently replace a teammate's edit", () => {
    const { share, hook, at } = setup();
    hook(share);
    at(["scope", "on"]);
    const id = at([
      "save",
      "--kind",
      "caveat",
      "--title",
      "Refunds",
      "--body",
      "Exclude refund_flag",
    ]).stdout.match(/caveat (\S+):/)![1];
    at(["share", id, "--yes"]);
    const file = join(share, "caveats", "refunds.md");
    writeFileSync(file, `${readFileSync(file, "utf-8")}\nTeammate: also exclude test orders.\n`);
    expect(at(["share", id]).stdout).toContain("REPLACE");
    const r = at(["share", id, "--yes"]);
    expect(r.status).toBe(1);
    expect(readFileSync(file, "utf-8")).toContain("Teammate");
    expect(at(["share", id, "--yes", "--update"]).status).toBe(0);
  });

  it("without a team folder, notes only go to their own project's .engram/", () => {
    const { e, at } = setup();
    const x = join(e.ROOT!, "x");
    const y = join(e.ROOT!, "y");
    mkdirSync(join(x, ".git"), { recursive: true });
    mkdirSync(join(y, ".engram"), { recursive: true });
    mkdirSync(join(y, ".git"));
    const id = at(
      ["save", "--kind", "caveat", "--title", "X private", "--body", "b"],
      x,
    ).stdout.match(/caveat (\S+):/)![1];
    const r = at(["share", id, "--yes"], y);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("share it from that project");
  });
});

describe("purge, resanitize and the capture opt-out", () => {
  function setup() {
    const e = env();
    mkdirSync(join(e.ROOT!, ".git"), { recursive: true });
    const at = (args: string[]) =>
      spawnSync("node", [CLI, ...args], { env: e, cwd: e.ROOT, encoding: "utf-8" });
    const hook = (payload: object) =>
      spawnSync("node", [CLI, "hook", "tool"], {
        env: e,
        cwd: e.ROOT,
        input: JSON.stringify({
          session_id: "s1",
          cwd: e.ROOT,
          hook_event_name: "PostToolUse",
          ...payload,
        }),
        encoding: "utf-8",
      });
    const obsLines = () => {
      const dir = join(e.ENGRAM_HOME!, "obs");
      if (!existsSync(dir)) return [] as string[];
      return (readdirSync(dir, { recursive: true }) as string[])
        .filter((f) => String(f).endsWith(".jsonl"))
        .flatMap((f) =>
          readFileSync(join(dir, String(f)), "utf-8")
            .split("\n")
            .filter(Boolean),
        );
    };
    return { e, at, hook, obsLines };
  }

  it("purges matching observations and reports the count per store", () => {
    const { at, hook, obsLines } = setup();
    hook({ tool_name: "Bash", tool_input: { command: "bq query 'SELECT id FROM dim_users'" } });
    hook({ tool_name: "Bash", tool_input: { command: "psql -c 'SELECT 1 FROM orders'" } });
    at(["save", "--kind", "caveat", "--title", "dim_users soft deletes", "--body", "b"]);
    expect(obsLines().length).toBe(2);

    const r = at(["purge", "dim_users"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("observations: 1");
    expect(r.stdout).toContain("notes: 1");
    expect(obsLines().length).toBe(1);
    expect(obsLines()[0]).not.toContain("dim_users");
    expect(obsLines()[0]).toContain("orders");
  });

  it("purges a single observation by id", () => {
    const { at, hook, obsLines } = setup();
    hook({ tool_name: "Bash", tool_input: { command: "bq query 'SELECT id FROM dim_users'" } });
    const id = JSON.parse(obsLines()[0]).id as string;
    const r = at(["purge", id]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("observations: 1");
    expect(obsLines().length).toBe(0);
  });

  it("reports no match without failing when the pattern is absent", () => {
    const { at, hook } = setup();
    hook({ tool_name: "Bash", tool_input: { command: "bq query 'SELECT id FROM dim_users'" } });
    const r = at(["purge", "no_such_marker"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("observations: 0");
  });

  it("rejects an invalid regular expression", () => {
    const { at } = setup();
    const r = at(["purge", "a(b"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Invalid regular expression");
  });

  it("resanitize applies current rules to records written before them", () => {
    const { e, at } = setup();
    const home = e.ENGRAM_HOME!;
    mkdirSync(join(home, "obs", "proj"), { recursive: true });
    mkdirSync(join(home, "recaps"), { recursive: true });
    const jwtish = ["ya", "29.", "Zq9Lm2XwRt4Yw7Pb3Nc5Vd1"].join("");
    writeFileSync(
      join(home, "obs", "proj", "s1.jsonl"),
      `${JSON.stringify({ t: "obs", id: "obs-a1", ts: 1, project: "proj", tool: "Bash", input: `curl ${jwtish}` })}\n`,
    );
    writeFileSync(
      join(home, "notes.jsonl"),
      `${JSON.stringify({ t: "note", id: "note-b2", ts: 1, project: "proj", kind: "fact", title: "t", body: `hf_${"Q".repeat(34)}` })}\n`,
    );
    writeFileSync(
      join(home, "recaps", "proj.json"),
      JSON.stringify({
        session: "s1",
        project: "proj",
        ts: 1,
        lastReply: "Sent Cookie: sid=Zq9Lm2Xwabcd; Path=/",
      }),
    );

    const r = at(["resanitize"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("observations: 1");
    expect(r.stdout).toContain("notes: 1");
    expect(r.stdout).toContain("recaps: 1");
    expect(readFileSync(join(home, "obs", "proj", "s1.jsonl"), "utf-8")).not.toContain(jwtish);
    expect(readFileSync(join(home, "notes.jsonl"), "utf-8")).not.toContain("Q".repeat(34));
    expect(readFileSync(join(home, "recaps", "proj.json"), "utf-8")).not.toContain("Zq9Lm2Xwabcd");
  });

  it("a .engram-ignore file stops capture and shows in status", () => {
    const { e, at, hook, obsLines } = setup();
    hook({ tool_name: "Bash", tool_input: { command: "bq query 'SELECT id FROM dim_users'" } });
    expect(obsLines().length).toBe(1);
    expect(at(["status"]).stdout).toContain("capture: on");

    writeFileSync(join(e.ROOT!, ".engram-ignore"), "");
    hook({ tool_name: "Bash", tool_input: { command: "bq query 'SELECT id FROM orders'" } });
    expect(obsLines().length).toBe(1);
    expect(obsLines().join("\n")).not.toContain("orders");
    expect(at(["status"]).stdout).toContain(".engram-ignore");
  });
});

describe("postings index under node", () => {
  it("is built after the first prompt answers, extended by captures, and gives the same answer", () => {
    const e = env();
    mkdirSync(join(e.ROOT!, ".git"), { recursive: true });
    const hook = (event: string, payload: object) =>
      run(e, ["hook", event], JSON.stringify({ session_id: "s1", cwd: e.ROOT, ...payload }));
    const tool = (command: string, error?: string) =>
      hook("tool", {
        hook_event_name: error ? "PostToolUseFailure" : "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        error,
      });
    tool(
      "bq query 'SELECT country FROM analytics.dim_users'",
      "Exit code 1\nAccess Denied: dim_users",
    );
    const ask = (session: string) =>
      run(
        e,
        ["hook", "prompt"],
        JSON.stringify({
          session_id: session,
          cwd: e.ROOT,
          hook_event_name: "UserPromptSubmit",
          prompt: "dim_users access denied again?",
        }),
      ).stdout;
    const index = join(e.ENGRAM_HOME!, "index");
    const first = ask("s2");
    expect(first).toContain("Access Denied");
    expect(readdirSync(index).length).toBe(1);
    tool("python etl/load.py --since 2024-01-01");
    const project = readdirSync(index)[0];
    expect(existsSync(join(index, project, "delta.jsonl"))).toBe(true);
    // A new session (the ledger would hide a repeat) reads the index and its delta.
    expect(ask("s3")).toBe(first);
  });
});

describe("status, history and usage", () => {
  it("shows hook errors and warns when they are recent", () => {
    const e = env();
    expect(run(e, ["status"]).stdout).toContain("hook errors: none logged");
    // A hook that cannot parse its input logs the failure and still exits 0.
    expect(run(e, ["hook", "prompt"], "not json").status).toBe(0);
    const out = run(e, ["status"]).stdout;
    expect(out).toMatch(/hook errors: 1 logged, last \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(out).toContain("WARNING: 1 hook error(s) in the past 7 days");
    expect(out).toContain("SyntaxError");
  });

  it("does not warn about errors older than a week", () => {
    const e = env();
    mkdirSync(e.ENGRAM_HOME!, { recursive: true });
    writeFileSync(join(e.ENGRAM_HOME!, "error.log"), "2020-01-02T03:04:05.000Z Error: old\n");
    const out = run(e, ["status"]).stdout;
    expect(out).toContain("hook errors: 1 logged, last 2020-01-0");
    expect(out).not.toContain("WARNING");
  });

  it("shows when this project last captured anything", () => {
    const e = env();
    expect(run(e, ["status"]).stdout).toContain("last capture in this project: never");
    run(e, ["hook", "prompt"], fixture("user-prompt-submit"));
    expect(run(e, ["status"]).stdout).toMatch(
      /last capture in this project: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/,
    );
  });

  it("history --all <date> shows every project's records for that day", () => {
    const e = env();
    const other = join(e.ROOT!, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    mkdirSync(join(e.ROOT!, ".git"), { recursive: true });
    const prompt = (cwd: string, text: string) =>
      run(
        e,
        ["hook", "prompt"],
        JSON.stringify({
          session_id: "s1",
          cwd,
          hook_event_name: "UserPromptSubmit",
          prompt: text,
        }),
      );
    prompt(e.ROOT!, "revenue by month here");
    prompt(other, "churn in the other repo");
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const mine = run(e, ["history", today]).stdout;
    expect(mine).toContain("revenue by month here");
    expect(mine).not.toContain("churn in the other repo");
    const all = run(e, ["history", today, "--all"]).stdout;
    expect(all).toContain("in all projects");
    expect(all).toContain("revenue by month here");
    expect(all).toContain("churn in the other repo");
  });

  it("reports notes by source and lifecycle state", () => {
    const e = env();
    run(e, ["save", "--kind", "caveat", "--title", "c1", "--body", "b"]);
    run(e, ["save", "--kind", "metric", "--title", "m1", "--body", "b", "--global"]);
    const out = run(e, ["status"]).stdout;
    expect(out).toContain("notes by source: auto 0, curated 2, shared with the team 0; global 1");
    expect(out).toContain("lifecycle: active 2, demoted 0");
  });

  it("save --global and recall --all cross project lines on purpose", () => {
    const e = env();
    const other = join(e.ROOT!, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    mkdirSync(join(e.ROOT!, ".git"), { recursive: true });
    const at = (cwd: string, args: string[]) =>
      spawnSync("node", [CLI, ...args], { env: e, cwd, encoding: "utf-8" });
    expect(
      at(other, ["save", "--kind", "caveat", "--title", "orders local quirk"]).stdout,
    ).not.toContain("global");
    expect(
      at(other, ["save", "--kind", "metric", "--title", "orders revenue rule", "--global"]).stdout,
    ).toContain("(global: recalled in every project)");
    const here = at(e.ROOT!, ["recall", "orders"]).stdout;
    expect(here).toContain("orders revenue rule");
    expect(here).not.toContain("orders local quirk");
    expect(at(e.ROOT!, ["recall", "orders", "--all"]).stdout).toContain("orders local quirk");
  });

  /** A failed query on dim_users, its fix, another run, a caveat and an unrelated global metric. */
  function analystStore() {
    const e = env();
    mkdirSync(join(e.ROOT!, ".git"), { recursive: true });
    const tool = (command: string, error?: string) =>
      run(
        e,
        ["hook", "tool"],
        JSON.stringify({
          session_id: "s1",
          cwd: e.ROOT,
          hook_event_name: error ? "PostToolUseFailure" : "PostToolUse",
          tool_name: "Bash",
          tool_input: { command },
          error,
        }),
      );
    tool(
      "bq query 'SELECT signup_dt FROM analytics.dim_users'",
      "Exit code 1\nUnrecognized name: signup_dt",
    );
    tool("bq query 'SELECT signup_date FROM analytics.dim_users'");
    tool("bq query 'SELECT country FROM analytics.dim_users, analytics.fct_orders'");
    run(e, [
      "save",
      "--kind",
      "caveat",
      "--title",
      "dim_users keeps soft-deleted accounts",
      "--tables",
      "analytics.dim_users",
      "--body",
      "Filter deleted_at IS NULL.",
    ]);
    run(e, [
      "save",
      "--kind",
      "metric",
      "--title",
      "Active user definition",
      "--tables",
      "fct_sessions",
      "--global",
    ]);
    return e;
  }

  it("table prints the card for one table", () => {
    const e = analystStore();
    const out = run(e, ["table", "dim_users"]).stdout;
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe("engram table: dim_users");
    expect(lines[1]).toMatch(
      /^- last touched: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(3 recorded run\(s\) in this project, 1 failed\)$/,
    );
    expect(out).toContain("Caveats and notes:\n- [caveat ");
    expect(out).toContain("dim_users keeps soft-deleted accounts: Filter deleted_at IS NULL.");
    expect(out).toContain("Most common errors:\n- 1× Unrecognized name: signup_dt (last ");
    expect(out).toContain("Fixes that resolved errors:\n- [fix ");
    expect(out).toContain("worked: bq query 'SELECT signup_date FROM analytics.dim_users'");
    expect(out).not.toContain("Active user definition");
    // A qualified name finds the same card.
    expect(run(e, ["table", "analytics.dim_users"]).stdout).toContain(
      "1× Unrecognized name: signup_dt",
    );
  });

  it("table respects project scoping and says when it knows nothing", () => {
    const e = analystStore();
    const other = join(e.ROOT!, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    const there = spawnSync("node", [CLI, "table", "dim_users"], {
      env: e,
      cwd: other,
      encoding: "utf-8",
    });
    expect(there.stdout).toContain("engram knows nothing about dim_users in this project");
    // A global note follows the user everywhere.
    const metric = spawnSync("node", [CLI, "table", "fct_sessions"], {
      env: e,
      cwd: other,
      encoding: "utf-8",
    });
    expect(metric.stdout).toContain("Active user definition");
    expect(run(e, ["table"]).status).toBe(1);
  });

  it("stats reports disk use, records by kind and source, lifecycle and top tables", () => {
    const e = analystStore();
    const out = run(e, ["stats"]).stdout;
    expect(out).toMatch(/^engram stats\n- data dir: .+ \(\d+(\.\d)? (B|KB|MB) in \d+ files\)/);
    expect(out).toMatch(/ {2}- observations: \d+(\.\d)? (B|KB) in \d+ files/);
    expect(out).toContain("notes.jsonl ");
    expect(out).toContain(
      "- observations: 3 in this project (1 errors, 0 prompts); 3 across 1 project(s)",
    );
    expect(out).toContain("- notes: 3 (caveat 1, metric 1, fix 1); 3 recalled in this project");
    expect(out).toContain("- notes by source: auto 1, curated 2, shared with the team 0; global 1");
    expect(out).toContain("- lifecycle: active 3, demoted 0");
    expect(out).toContain(
      "- top tables in this project (by recorded runs):\n  - analytics.dim_users: 3\n  - analytics.fct_orders: 1",
    );
  });

  it("lists every implemented command and hook event in USAGE", () => {
    const usage = run(env(), []).stdout;
    const source = readFileSync(join(import.meta.dirname, "..", "src", "cli.ts"), "utf-8");
    const commands = [...source.matchAll(/cmd === "([\w-]+)"/g)].map((m) => m[1]);
    const events = [...source.matchAll(/event === "([\w-]+)"/g)].map((m) => m[1]);
    expect(commands.length).toBeGreaterThan(5);
    for (const c of commands) expect(usage).toMatch(new RegExp(`^  ${c}\\b`, "m"));
    for (const ev of events) expect(usage).toMatch(new RegExp(`hook <[^>]*\\b${ev}\\b`));
  });
});
