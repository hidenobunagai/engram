import type { GitKnowledgeStore } from "./git-store";
import type { LocalStorage } from "./storage";
import type { SearchParams, SearchResult } from "./types";

export class HybridSearchEngine {
  constructor(
    private gitStore: GitKnowledgeStore,
    private localStorage: LocalStorage,
  ) {}

  /**
   * Executes a hybrid search across Git-backed team knowledge and Local working memory.
   */
  public search(params: SearchParams): SearchResult[] {
    const { query, kinds, targetTable, limit = 10, includeLocalHistory = true } = params;
    const results: SearchResult[] = [];

    // 1. Search Git knowledge (Team-verified, high priority)
    const gitItems = this.gitStore.search(query, {
      targetTable,
    });

    for (const item of gitItems) {
      if (kinds && !kinds.includes(item.kind)) continue;

      // Higher base score for team-reviewed git knowledge
      let score = 100;
      if (
        targetTable &&
        item.target_tables?.some((t) => t.toLowerCase() === targetTable.toLowerCase())
      ) {
        score += 50;
      }

      results.push({
        id: item.id,
        source: "git",
        kind: item.kind,
        title: item.title,
        content: item.body,
        targetTables: item.target_tables,
        tags: item.tags,
        score,
        filePath: item.filePath,
        createdAt: item.created_at,
      });
    }

    // 2. Search Local SQLite storage (Personal working memory & observations)
    if (includeLocalHistory) {
      const localResults = this.localStorage.search(query, undefined, limit);

      for (const item of localResults) {
        if (kinds && !kinds.includes(item.kind as any)) continue;

        let score = 50;
        if (
          targetTable &&
          item.targetTables?.some((t) => t.toLowerCase() === targetTable.toLowerCase())
        ) {
          score += 30;
        }

        results.push({
          ...item,
          score,
        });
      }
    }

    // Sort by score descending
    results.sort((a, b) => (b.score || 0) - (a.score || 0));

    return results.slice(0, limit);
  }

  /**
   * Generates a context injection block suitable for prepending to Claude Code prompts.
   */
  public buildContextBlock(targetTables?: string[]): string {
    const allGitItems = this.gitStore.loadAll();
    if (allGitItems.length === 0) return "";

    const relevantCaveats = allGitItems.filter((i) => i.kind === "caveat");
    const relevantMetrics = allGitItems.filter((i) => i.kind === "metric");

    if (relevantCaveats.length === 0 && relevantMetrics.length === 0) return "";

    const lines: string[] = ["# Team Data Knowledge (from .engram/)"];

    if (relevantCaveats.length > 0) {
      lines.push("\n## ⚠️ Known Data Caveats & Table Quirks:");
      for (const c of relevantCaveats.slice(0, 5)) {
        const tables =
          c.target_tables && c.target_tables.length > 0
            ? ` [Tables: ${c.target_tables.join(", ")}]`
            : "";
        lines.push(`- **${c.title}**${tables}: ${c.body.split("\n")[0]}`);
      }
    }

    if (relevantMetrics.length > 0) {
      lines.push("\n## 📐 Official Metric Definitions:");
      for (const m of relevantMetrics.slice(0, 5)) {
        lines.push(`- **${m.title}**: ${m.body.split("\n")[0]}`);
      }
    }

    return lines.join("\n");
  }
}
