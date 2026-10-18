import { describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
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
