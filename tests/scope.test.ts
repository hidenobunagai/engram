import { describe, expect, it } from "bun:test";
import { mkdirSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { onPrompt, onSessionStart } from "../src/hooks";
import { normalizeRemote, refreshSnapshot, setSelected, teamScope } from "../src/team";
import { sandbox } from "./helpers";

/** A fake repo whose .git/config has the given origin URL. */
function repo(root: string, name: string, url: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(
    join(dir, ".git", "config"),
    `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n`,
  );
  return dir;
}

function team(scope?: object) {
  const t = process.env.ENGRAM_TEAM_DIR!;
  mkdirSync(join(t, "caveats"), { recursive: true });
  writeFileSync(
    join(t, "caveats", "a.md"),
    '---\nid: c1\ntitle: Soft deletes in dim_users\ntarget_tables: ["dim_users"]\n---\nFilter deleted_at IS NULL.',
  );
  if (scope) writeFileSync(join(t, "scope.json"), JSON.stringify(scope));
  refreshSnapshot(0);
}

const ev = (cwd: string, extra: object) => ({ session_id: "s1", cwd, ...extra }) as any;

describe("team scope", () => {
  it("normalizes remotes", () => {
    expect(normalizeRemote("git@github.com:Acme/dbt-core.git")).toBe("github.com/acme/dbt-core");
    expect(normalizeRemote("ssh://git@gitlab.corp:2222/data/repo.git")).toBe(
      "gitlab.corp/data/repo",
    );
    expect(normalizeRemote("https://user:tok@github.com/a/b/")).toBe("github.com/a/b");
  });

  it("keeps every project out until it is selected, once a team folder exists", () => {
    const { work } = sandbox();
    team();
    const dot = repo(work, "dotfiles", "git@github.com:me/dotfiles.git");
    const kpi = repo(work, "kpi", "git@github.com:acme-analytics/kpi.git");
    expect(teamScope(dot).inScope).toBe(false);
    setSelected(kpi, true);
    expect(teamScope(kpi)).toMatchObject({
      inScope: true,
      reason: "selected with /engram:scope on",
    });
    // A second clone of the same remote counts as the same project.
    expect(teamScope(repo(work, "kpi-copy", "https://github.com/acme-analytics/kpi")).inScope).toBe(
      true,
    );
    setSelected(kpi, false);
    expect(teamScope(kpi).inScope).toBe(false);
    expect(teamScope(dot).inScope).toBe(false);
  });

  it("keeps working from the snapshot when the team folder goes offline", () => {
    const { work } = sandbox();
    team();
    const kpi = repo(work, "kpi", "git@github.com:acme-analytics/kpi.git");
    setSelected(kpi, true);
    refreshSnapshot(0);
    renameSync(process.env.ENGRAM_TEAM_DIR!, `${process.env.ENGRAM_TEAM_DIR}-offline`);
    expect(onSessionStart(ev(kpi, { source: "startup" }))).toContain("Soft deletes in dim_users");
    expect(onPrompt(ev(kpi, { session_id: "s2", prompt: "dim_users の件数を出して" }))).toContain(
      "Soft deletes in dim_users",
    );
    expect(refreshSnapshot(0).error).toContain("not reachable");
  });

  it("matches analysis repos by remote or path and keeps others out", () => {
    const { work } = sandbox();
    team({ projects: ["github.com/acme-analytics/*"], paths: [join(work, "adhoc", "*")] });
    const analytics = repo(work, "kpi", "git@github.com:acme-analytics/kpi.git");
    const dotfiles = repo(work, "dotfiles", "git@github.com:me/dotfiles.git");
    const adhoc = join(work, "adhoc", "q1");
    mkdirSync(adhoc, { recursive: true });
    expect(teamScope(analytics).inScope).toBe(true);
    expect(teamScope(join(analytics, "models", "sub")).inScope).toBe(true);
    expect(teamScope(adhoc).inScope).toBe(true);
    expect(teamScope(dotfiles)).toMatchObject({ inScope: false });

    expect(onSessionStart(ev(analytics, { source: "startup" }))).toContain(
      "Soft deletes in dim_users",
    );
    expect(onSessionStart(ev(dotfiles, { source: "startup" }))).not.toContain("team knowledge");
    expect(onPrompt(ev(dotfiles, { prompt: "dim_users の件数" }))).toBe("");
  });

  it("a .engram/ folder puts a repo in scope", () => {
    const { work } = sandbox();
    team({ projects: [] });
    const r = repo(work, "x", "git@github.com:me/x.git");
    mkdirSync(join(r, ".engram"));
    expect(teamScope(r).inScope).toBe(true);
  });

  it("reads remotes of worktrees through commondir", () => {
    const { work } = sandbox();
    team({ projects: ["github.com/acme-analytics/*"] });
    const main = repo(work, "kpi", "git@github.com:acme-analytics/kpi.git");
    const wtGit = join(main, ".git", "worktrees", "wt");
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, "commondir"), "../..\n");
    const wt = join(work, "kpi-wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
    expect(teamScope(wt).inScope).toBe(true);
  });
});

describe("scope review regressions", () => {
  it("rejects scope.json of the wrong shape without throwing", () => {
    const { work } = sandbox();
    const r = repo(work, "kpi", "git@github.com:acme-analytics/kpi.git");
    for (const bad of ["null", '{"projects":"github.com/*"}', '{"projects":[null]}', "[]"]) {
      team();
      writeFileSync(join(process.env.ENGRAM_TEAM_DIR!, "scope.json"), bad);
      refreshSnapshot(0);
      expect(teamScope(r).reason).toContain("scope.json is invalid");
      expect(onSessionStart(ev(r, { source: "startup" }))).toContain("personal memory");
    }
  });

  it("normalizes .git/ remotes", () => {
    expect(normalizeRemote("https://github.com/acme/kpi.git/")).toBe("github.com/acme/kpi");
  });
});
