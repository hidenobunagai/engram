import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { handleCaveatCommand, handleRecallCommand, handleStatusCommand } from "../src/commands/index";
import { GitKnowledgeStore } from "../src/core/git-store";
import { HybridSearchEngine } from "../src/core/search";
import { LocalStorage } from "../src/core/storage";
import type { ToolContext } from "../src/tools/index";

const TEST_DIR = join(import.meta.dir, "tmp-commands-test");

describe("Engram Commands", () => {
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
      project: "cmd-test-project",
    };
  });

  afterAll(() => {
    ctx.localStorage.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("handles status command", async () => {
    const status = await handleStatusCommand(ctx);
    expect(status.message).toContain("Engram Knowledge Base Status");
    expect(status.data.gitItemsCount).toBe(0);
  });

  it("handles caveat command and saves into .engram", async () => {
    const res = await handleCaveatCommand(ctx, "Users Missing Email | Some social logins lack verified email.");
    expect(res.message).toContain("Saved new team caveat to");

    const status = await handleStatusCommand(ctx);
    expect(status.data.caveats).toBe(1);
  });

  it("handles recall command", async () => {
    const recall = await handleRecallCommand(ctx, "social logins");
    expect(recall.message).toContain("Engram Recall");
    expect(recall.message).toContain("Users Missing Email");
  });
});
