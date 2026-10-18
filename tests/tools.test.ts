import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { GitKnowledgeStore } from "../src/core/git-store";
import { HybridSearchEngine } from "../src/core/search";
import { LocalStorage } from "../src/core/storage";
import { handleEngramRecall, handleEngramSave, type ToolContext } from "../src/tools/index";

const TEST_DIR = join(import.meta.dir, "tmp-tools-test");

describe("Engram Tools", () => {
  let ctx: ToolContext;

  beforeAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });

    const gitStore = new GitKnowledgeStore(TEST_DIR);
    gitStore.initDirectories();
    const localStorage = new LocalStorage(":memory:");
    const searchEngine = new HybridSearchEngine(gitStore, localStorage);

    ctx = {
      gitStore,
      localStorage,
      searchEngine,
      project: "test-analytics",
    };
  });

  afterAll(() => {
    ctx.localStorage.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("saves a caveat to Git store and recalls it", async () => {
    const saveRes = await handleEngramSave(ctx, {
      title: "Orders Null User Quirk",
      content: "When users checkout as guest, user_id is null.",
      kind: "caveat",
      targetTables: ["fct_orders"],
      tags: ["orders"],
      shareWithTeam: true,
      author: "analyst",
    });

    expect(saveRes.success).toBe(true);
    expect(saveRes.location).toContain(".engram");

    const recallRes = await handleEngramRecall(ctx, {
      query: "guest",
      targetTable: "fct_orders",
    });

    expect(recallRes.count).toBe(1);
    expect(recallRes.results[0].title).toBe("Orders Null User Quirk");
    expect(recallRes.results[0].source).toBe("git");
  });

  it("saves a personal entry to local db", async () => {
    const saveRes = await handleEngramSave(ctx, {
      title: "My Temporary Note",
      content: "Checking Q3 anomalies tomorrow.",
      kind: "fact",
      shareWithTeam: false,
    });

    expect(saveRes.success).toBe(true);
    expect(saveRes.location).toBe("local.db");

    const recallRes = await handleEngramRecall(ctx, {
      query: "anomalies",
    });

    expect(recallRes.count).toBe(1);
    expect(recallRes.results[0].source).toBe("local");
  });
});
