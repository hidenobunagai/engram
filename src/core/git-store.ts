import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import { sanitizeContent } from "./sanitizer";
import type { GitKnowledgeFrontmatter, GitKnowledgeItem, KnowledgeKind } from "./types";

/**
 * Parses simple YAML frontmatter without requiring heavy external YAML parsers.
 */
export function parseFrontmatter(fileContent: string): {
  frontmatter: Partial<GitKnowledgeFrontmatter>;
  body: string;
} {
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

export interface GitKnowledgeStoreOptions {
  projectDir?: string;
  globalDir?: string;
  customDir?: string;
}

export class GitKnowledgeStore {
  private globalDir: string;
  private projectDir?: string;
  private customDir?: string;

  constructor(options?: string | GitKnowledgeStoreOptions) {
    if (typeof options === "string") {
      // Backwards compatibility: single dir passed
      this.globalDir = resolve(options, ".engram");
    } else {
      const envDir = process.env.ENGRAM_DIR;
      this.customDir =
        options?.customDir || envDir ? resolve(options?.customDir || envDir!) : undefined;
      this.globalDir = options?.globalDir
        ? resolve(options.globalDir)
        : resolve(homedir(), ".claude", "engram");

      const proj = options?.projectDir || process.cwd();
      const projEngram = resolve(proj, ".engram");
      this.projectDir = existsSync(projEngram) ? projEngram : undefined;
    }
  }

  public getGlobalDirectory(): string {
    return this.globalDir;
  }

  public getProjectDirectory(): string | undefined {
    return this.projectDir;
  }

  /**
   * Returns active knowledge directories ordered by priority (custom -> project -> global).
   */
  public getActiveDirectories(): string[] {
    const dirs: string[] = [];
    if (this.customDir) {
      dirs.push(this.customDir);
      return dirs;
    }
    if (this.projectDir) dirs.push(this.projectDir);
    dirs.push(this.globalDir);
    return dirs;
  }

  /**
   * Ensures the knowledge directory structure exists.
   */
  public initDirectories(targetDir?: string): void {
    const base = targetDir || this.customDir || this.globalDir;
    const kinds: KnowledgeKind[] = ["caveat", "metric", "query", "decision", "fact"];
    for (const kind of kinds) {
      const dir = join(base, `${kind}s`);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Loads all knowledge items from active directories (global + project, project overrides global by ID).
   */
  public loadAll(): GitKnowledgeItem[] {
    const itemsMap = new Map<string, GitKnowledgeItem>();
    const kinds: KnowledgeKind[] = ["caveat", "metric", "query", "decision", "fact"];

    // Load in reverse order so that higher priority directories overwrite lower ones
    const dirs = [...this.getActiveDirectories()].reverse();

    for (const baseDir of dirs) {
      if (!existsSync(baseDir)) continue;

      for (const kind of kinds) {
        const dir = join(baseDir, `${kind}s`);
        if (!existsSync(dir)) continue;

        let files: string[] = [];
        try {
          files = readdirSync(dir).filter((f) => f.endsWith(".md"));
        } catch {
          continue;
        }

        for (const file of files) {
          const filePath = join(dir, file);
          try {
            const content = readFileSync(filePath, "utf-8");
            const { frontmatter, body } = parseFrontmatter(content);

            if (frontmatter.title && frontmatter.id) {
              itemsMap.set(frontmatter.id, {
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
    }

    return Array.from(itemsMap.values());
  }

  /**
   * Saves or updates a knowledge item as a markdown file.
   * By default saves to globalDir unless projectDir exists or saveTarget is specified.
   */
  public save(
    item: Omit<GitKnowledgeItem, "filePath"> & { slug?: string },
    options?: { saveTarget?: "global" | "project" },
  ): GitKnowledgeItem {
    let targetBase = this.globalDir;
    if (this.customDir) {
      targetBase = this.customDir;
    } else if (options?.saveTarget === "project" && this.projectDir) {
      targetBase = this.projectDir;
    }

    this.initDirectories(targetBase);

    const slug = item.slug || slugify(item.title) || item.id;
    const kindDir = join(targetBase, `${item.kind}s`);
    const filePath = join(kindDir, `${slug}.md`);

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
  public search(
    query: string,
    options: { kind?: KnowledgeKind; targetTable?: string } = {},
  ): GitKnowledgeItem[] {
    const all = this.loadAll();
    const q = query.toLowerCase().trim();

    return all.filter((item) => {
      if (options.kind && item.kind !== options.kind) return false;
      if (options.targetTable) {
        const hasTable = item.target_tables?.some(
          (t) => t.toLowerCase() === options.targetTable?.toLowerCase(),
        );
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
