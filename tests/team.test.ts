import { describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadTeam, parseFrontmatter, serialize, summaryOf, writeTeamItem } from "../src/team";
import { sandbox } from "./helpers";

const base = { kind: "caveat" as const, tables: [], tags: [], body: "body" };

describe("frontmatter", () => {
  it("round-trips quotes and strips newlines from scalars", () => {
    const text = serialize({ ...base, id: "x", title: 'Use "active"\nkind: metric' });
    const { meta } = parseFrontmatter(text);
    expect(meta.title).toBe('Use "active" kind: metric');
    expect(meta.kind).toBe("caveat");
  });
  it("accepts scalar, inline and block lists, BOM and CRLF", () => {
    const { meta } = parseFrontmatter(
      '﻿---\r\nid: a\r\ntarget_tables: dim_users\r\ntags:\r\n  - x\r\n  - "y, z"\r\n---\r\nbody',
    );
    expect(meta.target_tables).toBe("dim_users");
    expect(meta.tags).toEqual(["x", "y, z"]);
  });
  it("strips comments after quoted values", () => {
    expect(parseFrontmatter('---\nstatus: "active" # note\nb: x # c\n---\n').meta).toEqual({
      status: "active",
      b: "x",
    });
  });
  it("summary skips headings", () =>
    expect(summaryOf({ body: "### Problem\n\nRows are duplicated." })).toBe(
      "Rows are duplicated.",
    ));
});

describe("team store", () => {
  it("loads queries/ and tolerates scalar tables; reports invalid files", () => {
    const { work } = sandbox();
    const team = process.env.ENGRAM_TEAM_DIR!;
    mkdirSync(join(team, "queries"), { recursive: true });
    writeFileSync(
      join(team, "queries", "q.md"),
      "---\nid: q1\nkind: query\ntitle: Q\ntarget_tables: dim_users\n---\nSELECT 1",
    );
    writeFileSync(join(team, "queries", "bad.md"), "no frontmatter");
    const { items, skipped } = loadTeam(work);
    expect(items.map((i) => [i.id, i.tables])).toEqual([["q1", ["dim_users"]]]);
    expect(skipped.length).toBe(1);
  });
  it("never overwrites another item with the same title", () => {
    const { work } = sandbox();
    const team = process.env.ENGRAM_TEAM_DIR!;
    writeTeamItem(team, { ...base, id: "a", title: "Null revenue", body: "alice" });
    writeTeamItem(team, { ...base, id: "b", title: "Null revenue", body: "bob" });
    expect(readdirSync(join(team, "caveats")).sort()).toEqual([
      "null-revenue-2.md",
      "null-revenue.md",
    ]);
    expect(loadTeam(work).items.length).toBe(2);
  });
  it("keeps Japanese titles readable in file names", () => {
    sandbox();
    const p = writeTeamItem(process.env.ENGRAM_TEAM_DIR!, {
      ...base,
      id: "j",
      title: "売上の計上方法",
    });
    expect(p.endsWith("売上の計上方法.md")).toBe(true);
    expect(readFileSync(p, "utf-8")).toContain('title: "売上の計上方法"');
  });
});
