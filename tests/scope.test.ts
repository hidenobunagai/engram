import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { onPrompt, onSessionStart } from "../src/hooks";
import { normalizeRemote, teamScope } from "../src/team";
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

  it("treats every project as in scope until scope.json exists", () => {
    const { work } = sandbox();
    team();
    expect(teamScope(repo(work, "dotfiles", "git@github.com:me/dotfiles.git")).inScope).toBe(true);
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
