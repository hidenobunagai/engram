/**
 * Supported knowledge categories tailored for data analysts.
 */
export type KnowledgeKind = "caveat" | "metric" | "query" | "decision" | "fact";

export type KnowledgeSource = "local" | "git";

/**
 * Frontmatter metadata for markdown knowledge files stored under .engram/
 */
export interface GitKnowledgeFrontmatter {
  id: string;
  kind: KnowledgeKind;
  title: string;
  target_tables?: string[];
  tags?: string[];
  author?: string;
  created_at: string;
  updated_at?: string;
}

/**
 * A verified team knowledge item loaded from .engram/
 */
export interface GitKnowledgeItem extends GitKnowledgeFrontmatter {
  filePath: string;
  body: string;
}

/**
 * Local entry saved in private SQLite DB.
 */
export interface LocalEntry {
  id: string;
  project: string;
  kind: KnowledgeKind;
  title: string;
  content: string;
  targetTables?: string[];
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Automated observation captured from tool executions (queries, errors, fixes).
 */
export interface LocalObservation {
  id: string;
  sessionId: string;
  project: string;
  toolName: string;
  title: string;
  content: string;
  isError: boolean;
  createdAt: number;
}

/**
 * Claude Code session record.
 */
export interface LocalSession {
  id: string;
  project: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  summary?: string;
}

/**
 * Unified search result combining Git knowledge and Local observations/entries.
 */
export interface SearchResult {
  id: string;
  source: KnowledgeSource;
  kind: KnowledgeKind | "observation";
  title: string;
  content: string;
  targetTables?: string[];
  tags?: string[];
  score?: number;
  filePath?: string;
  createdAt: number | string;
}

/**
 * Parameters for searching knowledge.
 */
export interface SearchParams {
  query: string;
  kinds?: (KnowledgeKind | "observation")[];
  targetTable?: string;
  limit?: number;
  includeLocalHistory?: boolean;
}
