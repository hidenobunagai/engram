import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import {
  GitKnowledgeStore,
  parseFrontmatter,
  serializeKnowledge,
  slugify,
} from "../src/core/git-store";

const TEST_DIR = join(import.meta.dir, "tmp-git-store");
const GLOBAL_DIR = join(TEST_DIR, "global-engram");
const PROJ_DIR = join(TEST_DIR, "proj-engram");

describe("GitKnowledgeStore", () => {
  beforeAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(GLOBAL_DIR, { recursive: true });
    mkdirSync(join(PROJ_DIR, ".engram"), { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("slugifies titles correctly", () => {
    expect(slugify("Dim Users Soft Deletes & NULLs")).toBe("dim-users-soft-deletes-nulls");
    expect(slugify("   Monthly Active Users (MAU) 2026   ")).toBe("monthly-active-users-mau-2026");
  });

  it("parses and serializes markdown frontmatter", () => {
    const raw = `---
id: "cav-1"
kind: "caveat"
title: "Testing Title"
target_tables: ["dim_users", "fct_orders"]
tags: ["retention", "billing"]
created_at: "2026-10-18"
---

### Problem Description
This is a test description.
`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.id).toBe("cav-1");
    expect(frontmatter.kind).toBe("caveat");
    expect(frontmatter.title).toBe("Testing Title");
    expect(frontmatter.target_tables).toEqual(["dim_users", "fct_orders"]);
    expect(frontmatter.tags).toEqual(["retention", "billing"]);
    expect(body).toBe("### Problem Description\nThis is a test description.");

    const reserialized = serializeKnowledge({
      id: "cav-1",
      kind: "caveat",
      title: "Testing Title",
      target_tables: ["dim_users", "fct_orders"],
      tags: ["retention", "billing"],
      created_at: "2026-10-18",
      body: "### Problem Description\nThis is a test description.",
    });
    expect(reserialized).toContain('id: "cav-1"');
    expect(reserialized).toContain('target_tables: ["dim_users", "fct_orders"]');
  });

  it("saves, loads, and sanitizes knowledge items in directory", () => {
    const store = new GitKnowledgeStore({
      globalDir: GLOBAL_DIR,
      projectDir: join(TEST_DIR, "isolated-proj"),
    });
    store.initDirectories();

    const saved = store.save({
      id: "cav-users-del",
      kind: "caveat",
      title: "Dim Users Soft Deletion",
      target_tables: ["dim_users"],
      tags: ["users", "critical"],
      created_at: "2026-10-18",
      body: "Always filter `deleted_at IS NULL`. Don't use postgresql://user:secret123@db:5432/warehouse",
    });

    expect(existsSync(saved.filePath)).toBe(true);
    expect(saved.body).toContain("[REDACTED_SECRET]");

    const all = store.loadAll();
    expect(all.length).toBe(1);
    expect(all[0].id).toBe("cav-users-del");
    expect(all[0].target_tables).toEqual(["dim_users"]);

    // Search tests
    const searchResult1 = store.search("Soft Deletion");
    expect(searchResult1.length).toBe(1);

    const searchResultTable = store.search("", { targetTable: "dim_users" });
    expect(searchResultTable.length).toBe(1);

    const searchNoMatch = store.search("nonexistent query");
    expect(searchNoMatch.length).toBe(0);
  });

  it("merges global and project-level knowledge with project override", () => {
    const store = new GitKnowledgeStore({
      globalDir: GLOBAL_DIR,
      projectDir: PROJ_DIR,
    });

    // Save a global metric
    store.save({
      id: "met-revenue",
      kind: "metric",
      title: "Gross Revenue Global",
      created_at: "2026-10-18",
      body: "Global definition of gross revenue.",
    });

    // Save a project-specific override for the same ID
    store.save(
      {
        id: "met-revenue",
        kind: "metric",
        title: "Gross Revenue Project Override",
        created_at: "2026-10-18",
        body: "Project-specific revenue calculation.",
      },
      { saveTarget: "project" },
    );

    // Save a project-only caveat
    store.save(
      {
        id: "cav-proj-only",
        kind: "caveat",
        title: "Project Specific Quirk",
        created_at: "2026-10-18",
        body: "Only applies to this project.",
      },
      { saveTarget: "project" },
    );

    const all = store.loadAll();
    // met-revenue should be overridden by project version
    const revMetric = all.find((i) => i.id === "met-revenue");
    expect(revMetric?.title).toBe("Gross Revenue Project Override");

    // cav-proj-only should be present
    const projCaveat = all.find((i) => i.id === "cav-proj-only");
    expect(projCaveat).toBeDefined();

    // cav-users-del from global should still be present
    const globalCaveat = all.find((i) => i.id === "cav-users-del");
    expect(globalCaveat).toBeDefined();
  });
});
