import type { GitKnowledgeStore } from "../core/git-store";
import type { HybridSearchEngine } from "../core/search";
import type { LocalStorage } from "../core/storage";
import type { KnowledgeKind, SearchResult } from "../core/types";

export interface ToolContext {
  gitStore: GitKnowledgeStore;
  localStorage: LocalStorage;
  searchEngine: HybridSearchEngine;
  project: string;
}

/**
 * Recall tool handler: Searches across team caveats, metrics, and local history.
 */
export async function handleEngramRecall(
  ctx: ToolContext,
  args: { query: string; kind?: KnowledgeKind; targetTable?: string; limit?: number },
): Promise<{ results: SearchResult[]; count: number }> {
  const limit = args.limit || 5;
  const results = ctx.searchEngine.search({
    query: args.query,
    kinds: args.kind ? [args.kind] : undefined,
    targetTable: args.targetTable,
    limit,
  });

  return {
    results,
    count: results.length,
  };
}

/**
 * Save tool handler: Persists a piece of knowledge into .engram/ (Git) or local DB.
 */
export async function handleEngramSave(
  ctx: ToolContext,
  args: {
    title: string;
    content: string;
    kind: KnowledgeKind;
    targetTables?: string[];
    tags?: string[];
    shareWithTeam?: boolean;
    author?: string;
  },
): Promise<{ success: boolean; id: string; location: string }> {
  const id = `${args.kind.slice(0, 3)}-${Date.now()}`;

  if (args.shareWithTeam) {
    const saved = ctx.gitStore.save({
      id,
      kind: args.kind,
      title: args.title,
      target_tables: args.targetTables,
      tags: args.tags,
      author: args.author,
      created_at: new Date().toISOString().slice(0, 10),
      body: args.content,
    });

    return {
      success: true,
      id: saved.id,
      location: saved.filePath,
    };
  }

  const saved = ctx.localStorage.saveEntry({
    id,
    project: ctx.project,
    kind: args.kind,
    title: args.title,
    content: args.content,
    targetTables: args.targetTables,
    tags: args.tags,
  });

  return {
    success: true,
    id: saved.id,
    location: "local.db",
  };
}
