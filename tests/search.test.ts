import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { GitKnowledgeStore } from "../src/core/git-store";
import { HybridSearchEngine } from "../src/core/search";
import { LocalStorage } from "../src/core/storage";

const TEST_DIR = join(import.meta.dir, "tmp-search-test");

describe("HybridSearchEngine", () => {
  let gitStore: GitKnowledgeStore;
  let localStorage: LocalStorage;
  let engine: HybridSearchEngine;

  beforeAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });

    gitStore = new GitKnowledgeStore(TEST_DIR);
    gitStore.initDirectories();

    localStorage = new LocalStorage(":memory:");
    engine = new HybridSearchEngine(gitStore, localStorage);

    // Populate Git store with a caveat
    gitStore.save({
      id: "cav-orders-null",
      kind: "caveat",
      title: "Orders NULL User ID",
      target_tables: ["fct_orders"],
      tags: ["orders", "guest-checkout"],
      created_at: "2026-10-18",
      body: "Guest orders have NULL user_id. Filter user_id IS NOT NULL for registered user retention.",
    });

    // Populate Local store with an observation
    localStorage.saveObservation({
      id: "obs-query-1",
      sessionId: "s1",
      project: "test-proj",
      toolName: "run_sql",
      title: "Query run on fct_orders",
      content: "Executed cohort retention query on fct_orders successfully.",
      isError: false,
    });
  });

  afterAll(() => {
    localStorage.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("prioritizes Git team knowledge over local observations", () => {
    const results = engine.search({ query: "fct_orders", limit: 5 });
    expect(results.length).toBeGreaterThan(0);

    // Git knowledge should be first due to higher weight
    expect(results[0].source).toBe("git");
    expect(results[0].title).toBe("Orders NULL User ID");
  });

  it("builds a concise prompt context block", () => {
    const context = engine.buildContextBlock();
    expect(context).toContain("# Team Data Knowledge (from .engram/)");
    expect(context).toContain("⚠️ Known Data Caveats & Table Quirks:");
    expect(context).toContain("Orders NULL User ID");
  });
});
