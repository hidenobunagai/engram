import type { ToolContext } from "../tools/index";

export interface CommandResult {
  message: string;
  data?: any;
}

/**
 * Handles `/engram:recall <query>`
 */
export async function handleRecallCommand(ctx: ToolContext, query: string): Promise<CommandResult> {
  const q = query.trim();
  if (!q) {
    return {
      message: "⚠️ Please specify a search query. Example: `/engram:recall dim_users`",
    };
  }

  const results = ctx.searchEngine.search({ query: q, limit: 5 });
  if (results.length === 0) {
    return {
      message: `🔍 No knowledge or session records found for "${q}".`,
    };
  }

  const lines = [`### 🧠 Engram Recall: "${q}"\n`];
  for (const r of results) {
    const badge = r.source === "git" ? "🤝 [Team Git]" : "💻 [Local]";
    const kindBadge = `\`${r.kind}\``;
    lines.push(`- **${r.title}** ${badge} ${kindBadge}`);
    const snippet = r.content.split("\n").slice(0, 2).join(" ");
    lines.push(`  > ${snippet}`);
  }

  return {
    message: lines.join("\n"),
    data: results,
  };
}

/**
 * Handles `/engram:status`
 */
export async function handleStatusCommand(ctx: ToolContext): Promise<CommandResult> {
  const gitItems = ctx.gitStore.loadAll();
  const caveats = gitItems.filter((i) => i.kind === "caveat").length;
  const metrics = gitItems.filter((i) => i.kind === "metric").length;
  const queries = gitItems.filter((i) => i.kind === "query").length;
  const decisions = gitItems.filter((i) => i.kind === "decision").length;

  const recent = ctx.localStorage.getRecentSession(ctx.project);

  const lines = [
    "### 🧠 Engram Knowledge Base Status",
    `- **Team Git Store (.engram/)**: ${gitItems.length} items`,
    `  - ⚠️ Caveats: ${caveats}`,
    `  - 📐 Metrics: ${metrics}`,
    `  - ⚡ Queries: ${queries}`,
    `  - 📝 Decisions: ${decisions}`,
    `- **Project**: ${ctx.project}`,
    `- **Last Session**: ${recent ? new Date(recent.startedAt).toLocaleString() : "None"}`,
  ];

  return {
    message: lines.join("\n"),
    data: { gitItemsCount: gitItems.length, caveats, metrics, queries, decisions },
  };
}

/**
 * Handles quick addition of a caveat: `/engram:caveat <title> | <details>`
 */
export async function handleCaveatCommand(ctx: ToolContext, input: string): Promise<CommandResult> {
  const parts = input.split("|").map((p) => p.trim());
  const title = parts[0];
  const content = parts[1] || title;

  if (!title) {
    return {
      message: "⚠️ Usage: `/engram:caveat <title> | <details>`",
    };
  }

  const saved = ctx.gitStore.save({
    id: `cav-${Date.now()}`,
    kind: "caveat",
    title,
    created_at: new Date().toISOString().slice(0, 10),
    body: content,
  });

  return {
    message: `✅ Saved new team caveat to: \`${saved.filePath}\`\nCommit and push this file to share with your team!`,
    data: saved,
  };
}
