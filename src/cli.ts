import { homedir } from "os";
import { join } from "path";
import { GitKnowledgeStore } from "./core/git-store";
import { HybridSearchEngine } from "./core/search";
import { LocalStorage } from "./core/storage";
import { handleCaveatCommand, handleRecallCommand, handleStatusCommand } from "./commands/index";
import type { ToolContext } from "./tools/index";

function getContext(): ToolContext {
  const cwd = process.cwd();
  const gitStore = new GitKnowledgeStore({ projectDir: cwd });
  const dbPath = join(homedir(), ".claude", "engram", "local.db");
  const localStorage = new LocalStorage(dbPath);
  const searchEngine = new HybridSearchEngine(gitStore, localStorage);
  const project = cwd.split("/").pop() || "project";

  return { gitStore, localStorage, searchEngine, project };
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  const ctx = getContext();

  switch (cmd) {
    case "status": {
      const res = await handleStatusCommand(ctx);
      console.log(res.message);
      break;
    }
    case "recall": {
      const query = args.join(" ");
      const res = await handleRecallCommand(ctx, query);
      console.log(res.message);
      break;
    }
    case "caveat": {
      const input = args.join(" ");
      const res = await handleCaveatCommand(ctx, input);
      console.log(res.message);
      break;
    }
    case "context": {
      const block = ctx.searchEngine.buildContextBlock();
      if (block) console.log(block);
      break;
    }
    default: {
      console.log("Usage: engram <status|recall|caveat|context> [args]");
      break;
    }
  }

  ctx.localStorage.close();
}

main().catch(console.error);
