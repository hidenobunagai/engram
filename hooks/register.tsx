import { homedir } from "os";
import { join } from "path";
import { GitKnowledgeStore } from "../src/core/git-store";
import { HybridSearchEngine } from "../src/core/search";
import { LocalStorage } from "../src/core/storage";

// Lazy-loaded storage instances
let gitStore: GitKnowledgeStore | null = null;
let localStorage: LocalStorage | null = null;
let searchEngine: HybridSearchEngine | null = null;

function getContext(cwd: string) {
  if (!gitStore || !localStorage || !searchEngine) {
    gitStore = new GitKnowledgeStore(cwd);
    const dbPath = join(homedir(), ".claude", "engram", "local.db");
    localStorage = new LocalStorage(dbPath);
    searchEngine = new HybridSearchEngine(gitStore, localStorage);
  }
  return { gitStore, localStorage, searchEngine };
}

export const register = (on: any) => {
  // Session start: inject team caveats & metrics into conversation context
  on("session.start", async ($: any, e: any, next: any) => {
    const cwd = e.cwd || process.cwd();
    const { gitStore: gs, searchEngine: se, localStorage: ls } = getContext(cwd);

    // Record session start
    const sessionId = e.sessionId || `sess-${Date.now()}`;
    const project = cwd.split("/").pop() || "project";
    ls.startSession({
      id: sessionId,
      project,
      cwd,
    });

    // Build context injection from team caveats & metrics
    const contextBlock = se.buildContextBlock();

    // If there is context, append to system or user instructions
    if (contextBlock && e.systemPrompt) {
      e.systemPrompt += `\n\n${contextBlock}`;
    }

    return next(e);
  });

  // Turn step: Observe tool executions (e.g., SQL queries, errors)
  on("turn.step", async function* ($: any, e: any, next: any) {
    const r = yield* next(e);
    const cwd = process.cwd();
    const { localStorage: ls } = getContext(cwd);

    // If tool execution completed
    if (r && r.toolResult) {
      const toolName = r.toolName || "tool";
      const isError = Boolean(r.isError || r.toolResult.error);
      const title = `${toolName} execution ${isError ? "failed" : "completed"}`;
      const content =
        typeof r.toolResult === "string" ? r.toolResult : JSON.stringify(r.toolResult);

      ls.saveObservation({
        id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        sessionId: e.sessionId || "current",
        project: cwd.split("/").pop() || "project",
        toolName,
        title,
        content: content.slice(0, 4000), // Cap observation length
        isError,
      });
    }

    return r;
  });

  // Session end / cleanup
  on("session.end", async ($: any, e: any, next: any) => {
    const cwd = process.cwd();
    const { localStorage: ls } = getContext(cwd);

    const sessionId = e.sessionId;
    if (sessionId) {
      ls.endSession(sessionId, "Session completed");
    }

    return next(e);
  });

  // AbovePrompt UI indicator
  on("ui.render", { component: "AbovePrompt" }, async ($: any, e: any, next: any) => {
    const cwd = process.cwd();
    const { gitStore: gs } = getContext(cwd);
    const gitItems = gs.loadAll();

    const caveats = gitItems.filter((i) => i.kind === "caveat").length;
    const metrics = gitItems.filter((i) => i.kind === "metric").length;

    const { Box, Text } = $.ui.resolve(e);

    return (
      <Box key="engram-status" alignItems="center">
        <Text dimColor>🧠 engram </Text>
        <Text color="cyan">
          {caveats} caveats, {metrics} metrics
        </Text>
      </Box>
    );
  });
};

export default register;
