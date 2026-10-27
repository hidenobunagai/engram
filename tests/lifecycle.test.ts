import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { buildDocs, onPreToolUse, onPrompt, onSessionStart, onToolUse } from "../src/hooks";
import {
  DECAY_MAX_HITS,
  allNotes,
  compactHits,
  dataDir,
  lifecycle,
  noteSource,
  noteUsage,
  projectId,
  projectRoot,
  recordHits,
  saveNote,
} from "../src/memory";
import { search } from "../src/search";
import { joinTeam, sandbox } from "./helpers";

const ev = (work: string, session: string, extra: object) =>
  ({ session_id: session, cwd: work, ...extra }) as any;
const DAY = 86_400_000;

const prompt = (work: string, session: string, text: string) =>
  onPrompt(ev(work, session, { hook_event_name: "UserPromptSubmit", prompt: text }));

/** The pairing hooks run: a failed query, then the corrected one. */
function pairFix(work: string, session: string) {
  onToolUse(
    ev(work, session, {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "bq query 'SELECT signup_dt FROM analytics.dim_users'" },
      error: "Unrecognized name: signup_dt",
    }),
  );
  onToolUse(
    ev(work, session, {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "bq query 'SELECT signup_date FROM analytics.dim_users'" },
    }),
  );
}

/** A note line as an older engram (or an earlier day) would have written it. */
function rawNote(note: object) {
  mkdirSync(dataDir(), { recursive: true });
  appendFileSync(join(dataDir(), "notes.jsonl"), `${JSON.stringify({ t: "note", ...note })}\n`);
}

describe("note sources", () => {
  it("marks paired fixes auto and saved notes user", () => {
    const { work } = sandbox();
    pairFix(work, "s1");
    saveNote({ project: projectId(work), kind: "caveat", title: "c", body: "b", source: "user" });
    const notes = allNotes();
    expect(notes.find((n) => n.kind === "fix")?.source).toBe("auto");
    expect(notes.find((n) => n.kind === "caveat")?.source).toBe("user");
  });

  it("infers the source of notes written before the field existed", () => {
    expect(noteSource({ kind: "fix", session: "s1" } as any)).toBe("auto");
    expect(noteSource({ kind: "fix" } as any)).toBe("user");
    expect(noteSource({ kind: "caveat", session: "s1" } as any)).toBe("user");
  });

  it("keeps the first save time across refreshes", () => {
    const { work } = sandbox();
    const a = saveNote({ project: projectId(work), kind: "caveat", title: "t", body: "b" });
    const b = saveNote({ project: projectId(work), kind: "caveat", title: "t", body: "b" });
    expect(b.id).toBe(a.id);
    expect(b.created).toBe(a.created!);
  });
});

describe("decay of automatic fixes", () => {
  const old = Date.now() - 100 * DAY;

  it("leaves an idle auto fix out of prompts but keeps it searchable", () => {
    const { work } = sandbox();
    const project = projectId(work);
    rawNote({
      id: "fix-old",
      ts: old,
      session: "s0",
      project,
      kind: "fix",
      source: "auto",
      title: "Fix: Unrecognized name: signup_dt",
      body: "Worked:\n```\nSELECT signup_date FROM dim_users\n```",
      tables: ["dim_users"],
    });
    rawNote({
      id: "cav-old",
      ts: old,
      project,
      kind: "caveat",
      source: "user",
      title: "dim_users keeps soft-deleted rows",
      body: "Filter deleted_at IS NULL.",
      tables: ["dim_users"],
    });
    expect(lifecycle(allNotes().find((n) => n.id === "fix-old")!).reason).toBe("idle");
    const ctx = prompt(work, "s1", "count dim_users by signup date");
    expect(ctx).toContain("cav-old");
    expect(ctx).not.toContain("fix-old");
    // recall (and history) still find it.
    const hits = search(buildDocs(work), "signup_dt dim_users", 10, 0).map((h) => h.doc.id);
    expect(hits).toContain("fix-old");
    // The pre-query check is injection too.
    const pre = onPreToolUse(
      ev(work, "s2", {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "bq query 'SELECT signup_dt FROM dim_users'" },
      }),
    );
    expect(pre).toContain("cav-old");
    expect(pre).not.toContain("fix-old");
  });

  it("never decays curated notes", () => {
    const n = { id: "x", ts: Date.now() - 1000 * DAY, kind: "caveat", source: "user" } as any;
    expect(lifecycle(n, { hits: 500 }).state).toBe("active");
  });

  it("counts injections and demotes an auto fix shown 10 times", () => {
    const { work } = sandbox();
    pairFix(work, "s0");
    const fix = allNotes().find((n) => n.kind === "fix")!;
    for (let i = 1; i <= DECAY_MAX_HITS; i++)
      expect(prompt(work, `s${i}`, "signup_dt on dim_users again")).toContain(fix.id);
    expect(noteUsage().get(fix.id)?.hits).toBe(DECAY_MAX_HITS);
    expect(lifecycle(fix, noteUsage().get(fix.id)).reason).toBe("unconfirmed");
    expect(prompt(work, "s99", "signup_dt on dim_users again")).not.toContain(fix.id);
  });

  it("re-activates a demoted fix when its error is paired again", () => {
    const { work } = sandbox();
    pairFix(work, "s0");
    const fix = allNotes().find((n) => n.kind === "fix")!;
    recordHits(Array(DECAY_MAX_HITS).fill(fix.id));
    expect(lifecycle(fix, noteUsage().get(fix.id)).state).toBe("demoted");
    pairFix(work, "s5");
    const again = allNotes().find((n) => n.id === fix.id)!;
    expect(noteUsage().get(fix.id)?.hits).toBe(0);
    expect(lifecycle(again, noteUsage().get(fix.id)).state).toBe("active");
  });

  it("keeps an auto fix that keeps being shown active past 90 days", () => {
    const fix = { id: "f", ts: Date.now() - 200 * DAY, kind: "fix", source: "auto" } as any;
    expect(lifecycle(fix, { hits: 2, lastInjected: Date.now() - 5 * DAY }).state).toBe("active");
  });

  it("compacts the hit log without changing the counts", () => {
    const { work } = sandbox();
    const a = saveNote({ project: projectId(work), kind: "caveat", title: "a", body: "a" });
    for (let i = 0; i < 300; i++) recordHits([a.id, "gone-note"], 1000 + i);
    const before = noteUsage().get(a.id);
    expect(compactHits()).toBe(true);
    expect(noteUsage().get(a.id)).toEqual(before!);
    expect(noteUsage().has("gone-note")).toBe(false);
    expect(
      readFileSync(join(dataDir(), "hits.jsonl"), "utf-8").split("\n").filter(Boolean).length,
    ).toBe(1);
  });
});

describe("project isolation", () => {
  function twoProjects() {
    const { work } = sandbox();
    const a = join(work, "client-a");
    const b = join(work, "client-b");
    mkdirSync(join(a, ".git"), { recursive: true });
    mkdirSync(join(b, ".git"), { recursive: true });
    return { work, a, b };
  }
  const caveat = (cwd: string, title: string, global = false) =>
    saveNote({
      project: projectId(cwd),
      kind: "caveat",
      title,
      body: "Filter deleted_at IS NULL.",
      tables: ["dim_users"],
      root: projectRoot(cwd),
      global,
    });

  it("does not inject a note saved in project A into project B", () => {
    const { a, b } = twoProjects();
    const note = caveat(a, "client A dim_users soft deletes");
    expect(prompt(a, "s1", "count dim_users by country")).toContain(note.id);
    expect(prompt(b, "s2", "count dim_users by country")).not.toContain(note.id);
    const pre = onPreToolUse(
      ev(b, "s3", {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "bq query 'SELECT * FROM dim_users'" },
      }),
    );
    expect(pre).not.toContain(note.id);
  });

  it("injects a global note everywhere", () => {
    const { a, b } = twoProjects();
    const note = caveat(a, "warehouse-wide dim_users soft deletes", true);
    expect(note.global).toBe(true);
    expect(prompt(b, "s2", "count dim_users by country")).toContain(note.id);
  });

  it("keeps other projects' notes out of the default recall, and in with --all", () => {
    const { a, b } = twoProjects();
    const note = caveat(a, "client A dim_users soft deletes");
    const ids = (opts = {}) =>
      search(buildDocs(b, opts), "dim_users soft deletes", 10, 0).map((h) => h.doc.id);
    expect(ids()).not.toContain(note.id);
    expect(ids({ allProjects: true })).toContain(note.id);
  });

  it("leaves team items as they were: injected wherever the project is in scope", () => {
    const { b } = twoProjects();
    const team = process.env.ENGRAM_TEAM_DIR!;
    mkdirSync(join(team, "caveats"), { recursive: true });
    writeFileSync(
      join(team, "caveats", "x.md"),
      "---\nid: team-users\ntitle: Team dim_users caveat\ntarget_tables: [dim_users]\n---\nbody",
    );
    expect(prompt(b, "s1", "count dim_users by country")).not.toContain("Team dim_users caveat");
    joinTeam(b);
    expect(prompt(b, "s2", "count dim_users by country")).toContain("Team dim_users caveat");
  });

  it("says at session start that other projects' notes stay there", () => {
    const { a, b } = twoProjects();
    caveat(a, "client A note");
    caveat(a, "global note", true);
    const start = onSessionStart(ev(b, "s1", { hook_event_name: "SessionStart" }));
    expect(start).toContain("holds 0 saved note(s) for this project, plus 1 global");
    expect(start).toContain("1 from other projects stay there");
  });
});

describe("project root markers", () => {
  const tree = (files: string[]) => {
    const { work } = sandbox();
    for (const f of files) {
      const path = join(work, f);
      if (f.endsWith("/")) mkdirSync(path, { recursive: true });
      else {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "");
      }
    }
    mkdirSync(join(work, "proj", "sub", "deep"), { recursive: true });
    return work;
  };
  const home = "/nonexistent-home";

  for (const marker of [".git/", ".jj/", ".engram/", "dbt_project.yml", "pyproject.toml"]) {
    it(`treats ${marker} as a project root`, () => {
      const work = tree([`proj/${marker}`]);
      expect(projectRoot(join(work, "proj", "sub", "deep"), home)).toBe(join(work, "proj"));
    });
  }

  it("treats a .git file (worktree, submodule) as a root but not a .engram file", () => {
    expect(projectRoot(join(tree(["proj/.git"]), "proj", "sub"), home)).toMatch(/proj$/);
    const work = tree(["proj/.engram"]);
    expect(projectRoot(join(work, "proj", "sub"), home)).toBe(join(work, "proj", "sub"));
  });

  it("falls back to cwd without any marker", () => {
    const work = tree([]);
    expect(projectRoot(join(work, "proj", "sub"), home)).toBe(join(work, "proj", "sub"));
  });

  it("never takes $HOME for a root, even with a marker there", () => {
    const work = tree(["proj/.git/", "proj/pyproject.toml"]);
    // proj plays the home folder: its markers are ignored, so cwd is the project.
    expect(projectRoot(join(work, "proj", "sub"), join(work, "proj"))).toBe(
      join(work, "proj", "sub"),
    );
    // Markers below home still count.
    const below = tree(["proj/sub/dbt_project.yml"]);
    expect(projectRoot(join(below, "proj", "sub", "deep"), join(below, "proj"))).toBe(
      join(below, "proj", "sub"),
    );
  });

  it("lets a nested git repository win over a marked parent folder", () => {
    const work = tree(["proj/pyproject.toml", "proj/sub/.git/"]);
    expect(projectRoot(join(work, "proj", "sub", "deep"), home)).toBe(join(work, "proj", "sub"));
    expect(projectRoot(join(work, "proj"), home)).toBe(join(work, "proj"));
  });

  it("does not split a repository at a marker inside it", () => {
    const work = tree(["proj/.git/", "proj/sub/dbt_project.yml"]);
    expect(projectRoot(join(work, "proj", "sub", "deep"), home)).toBe(join(work, "proj"));
  });

  it("gives every subfolder of a marked folder one project id", () => {
    const work = tree(["proj/dbt_project.yml"]);
    expect(projectId(join(work, "proj", "sub", "deep"))).toBe(projectId(join(work, "proj")));
  });
});
