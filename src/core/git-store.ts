import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import type { GitKnowledgeFrontmatter, GitKnowledgeItem, KnowledgeKind } from "./types";
import { sanitizeContent } from "./sanitizer";

/**
 * Parses simple YAML frontmatter without requiring heavy external YAML parsers.
 */
export function parseFrontmatter(fileContent: string): { frontmatter: Partial<GitKnowledgeFrontmatter>; body: string } {
  const match = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: fileContent.trim() };
  }

  const rawYaml = match[1] || "";
  const body = (match[2] || "").trim();
  const frontmatter: Record<string, unknown> = {};

  for (const line of rawYaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let val = trimmed.slice(colonIdx + 1).trim();

    // Parse string arrays: e.g. ["a", "b"] or ['a', 'b']
    if (val.startsWith("[") && val.endsWith("]")) {
      const items = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      frontmatter[key] = items;
      continue;
    }

    // Strip quotes from string values
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    frontmatter[key] = val;
  }

  return { frontmatter: frontmatter as Partial<GitKnowledgeFrontmatter>, body };
}

/**
 * Serializes frontmatter and markdown body into valid file content.
 */
export function serializeKnowledge(item: Omit<GitKnowledgeItem, "filePath">): string {
  const lines = ["---"];
  lines.push(`id: "${item.id}"`);
  lines.push(`kind: "${item.kind}"`);
  lines.push(`title: "${item.title.replace(/"/g, '\\"')}"`);

  if (item.target_tables && item.target_tables.length > 0) {
    const tables = item.target_tables.map((t) => `"${t}"`).join(", ");
    lines.push(`target_tables: [${tables}]`);
  }

  if (item.tags && item.tags.length > 0) {
    const tags = item.tags.map((t) => `"${t}"`).join(", ");
    lines.push(`tags: [${tags}]`);
  }

  if (item.author) {
    lines.push(`author: "${item.author}"`);
  }

  lines.push(`created_at: "${item.created_at}"`);
  if (item.updated_at) {
    lines.push(`updated_at: "${item.updated_at}"`);
  }

  lines.push("---");
  lines.push("");
  lines.push(item.body.trim());
  lines.push("");

  return lines.join("\n");
}

/**
 * Creates a URL/file-friendly slug from a title.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class GitKnowledgeStore {
  private baseDir: string;

  constructor(repoRoot: string) {
    this.baseDir = resolve(repoRoot, ".engram");
  }

  public getDirectory(): string {
    return this.baseDir;
  }

  /**
   * Ensures the .engram directory structure exists.
   */
  public initDirectories(): void {
    const kinds: KnowledgeKind[] = ["caveat", "metric", "query", "decision", "fact"];
    for (const kind of kinds) {
      const dir = join(this.baseDir, `${kind}s`);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Loads all knowledge items from .engram/
   */
  public loadAll(): GitKnowledgeItem[] {
    if (!existsSync(this.baseDir)) return [];

    const items: GitKnowledgeItem[] = [];
    const kinds: KnowledgeKind[] = ["caveat", "metric", "query", "decision", "fact"];

    for (const kind of kinds) {
      const dir = join(this.baseDir, `${kind}s`);
      if (!existsSync(dir)) continue;

      const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const filePath = join(dir, file);
        try {
          const content = readFileSync(filePath, "utf-8");
          const { frontmatter, body } = parseFrontmatter(content);

          if (frontmatter.title && frontmatter.id) {
            items.push({
              id: frontmatter.id,
              kind: (frontmatter.kind as KnowledgeKind) || kind,
              title: frontmatter.title,
              target_tables: frontmatter.target_tables || [],
              tags: frontmatter.tags || [],
              author: frontmatter.author,
              created_at: frontmatter.created_at || new Date().toISOString(),
              updated_at: frontmatter.updated_at,
              filePath,
              body,
            });
          }
        } catch {
          // Ignore corrupt or unreadable files gracefully
        }
      }
    }

    return items;
  }

  /**
   * Saves or updates a knowledge item as a markdown file.
   */
  public save(item: Omit<GitKnowledgeItem, "filePath"> & { slug?: string }): GitKnowledgeItem {
    this.initDirectories();

    const slug = item.slug || slugify(item.title) || item.id;
    const kindDir = join(this.baseDir, `${item.kind}s`);
    const filePath = join(kindDir, `${slug}.md`);

    // Ensure content is sanitized before writing to git
    const sanitizedBody = sanitizeContent(item.body);
    const sanitizedTitle = sanitizeContent(item.title);

    const fullItem: GitKnowledgeItem = {
      ...item,
      title: sanitizedTitle,
      body: sanitizedBody,
      filePath,
    };

    const serialized = serializeKnowledge(fullItem);
    writeFileSync(filePath, serialized, "utf-8");

    return fullItem;
  }

  /**
   * Searches loaded items by query, target table, or kind.
   */
  public search(query: string, options: { kind?: KnowledgeKind; targetTable?: string } = {}): GitKnowledgeItem[] {
    const all = this.loadAll();
    const q = query.toLowerCase().trim();

    return all.filter((item) => {
      if (options.kind && item.kind !== options.kind) return false;
      if (options.targetTable) {
        const hasTable = item.target_tables?.some((t) => t.toLowerCase() === options.targetTable?.toLowerCase());
        if (!hasTable) return false;
      }

      if (!q) return true;

      const titleMatch = item.title.toLowerCase().includes(q);
      const bodyMatch = item.body.toLowerCase().includes(q);
      const tagMatch = item.tags?.some((t) => t.toLowerCase().includes(q));
      const tableMatch = item.target_tables?.some((t) => t.toLowerCase().includes(q));

      return titleMatch || bodyMatch || tagMatch || tableMatch;
    });
  }
}
