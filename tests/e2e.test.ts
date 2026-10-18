import { describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
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
