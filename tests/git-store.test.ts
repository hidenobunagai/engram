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

describe("GitKnowledgeStore", () => {
  beforeAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
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
    const store = new GitKnowledgeStore(TEST_DIR);
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
});
