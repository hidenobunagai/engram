import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { sanitizeContent } from "./sanitizer";
import type { LocalEntry, LocalObservation, LocalSession, SearchResult } from "./types";

export class LocalStorage {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(dbPath);
    this.init();
  }

  /**
   * Initializes SQLite tables, constraints, and FTS5 trigram indexes.
   */
  public init(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        target_tables TEXT,
        tags TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        is_error INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        cwd TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        summary TEXT
      );
    `);

    // FTS5 virtual table for lightning-fast full-text search across titles & content
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
        id UNINDEXED,
        kind UNINDEXED,
        title,
        content,
        tokenize='trigram'
      );
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project);`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);`);
  }

  /**
   * Saves a personal entry and updates the FTS index.
   */
  public saveEntry(entry: Omit<LocalEntry, "createdAt" | "updatedAt">): LocalEntry {
    const now = Date.now();
    const cleanTitle = sanitizeContent(entry.title);
    const cleanContent = sanitizeContent(entry.content);

    const fullEntry: LocalEntry = {
      ...entry,
      title: cleanTitle,
      content: cleanContent,
      createdAt: now,
      updatedAt: now,
    };

    const targetTablesJson = entry.targetTables ? JSON.stringify(entry.targetTables) : "[]";
    const tagsJson = entry.tags ? JSON.stringify(entry.tags) : "[]";

    this.db.run(
      `INSERT OR REPLACE INTO entries (id, project, kind, title, content, target_tables, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fullEntry.id,
        fullEntry.project,
        fullEntry.kind,
        fullEntry.title,
        fullEntry.content,
        targetTablesJson,
        tagsJson,
        fullEntry.createdAt,
        fullEntry.updatedAt,
      ],
    );

    // Update FTS
    this.db.run(`DELETE FROM fts WHERE id = ?`, [fullEntry.id]);
    this.db.run(`INSERT INTO fts (id, kind, title, content) VALUES (?, ?, ?, ?)`, [
      fullEntry.id,
      fullEntry.kind,
      fullEntry.title,
      fullEntry.content,
    ]);

    return fullEntry;
  }

  /**
   * Records an observation from tool usage (e.g. SQL error or query result).
   */
  public saveObservation(obs: Omit<LocalObservation, "createdAt">): LocalObservation {
    const now = Date.now();
    const cleanTitle = sanitizeContent(obs.title);
    const cleanContent = sanitizeContent(obs.content);

    const fullObs: LocalObservation = {
      ...obs,
      title: cleanTitle,
      content: cleanContent,
      createdAt: now,
    };

    this.db.run(
      `INSERT INTO observations (id, session_id, project, tool_name, title, content, is_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fullObs.id,
        fullObs.sessionId,
        fullObs.project,
        fullObs.toolName,
        fullObs.title,
        fullObs.content,
        fullObs.isError ? 1 : 0,
        fullObs.createdAt,
      ],
    );

    // Update FTS
    this.db.run(`INSERT INTO fts (id, kind, title, content) VALUES (?, 'observation', ?, ?)`, [
      fullObs.id,
      fullObs.title,
      fullObs.content,
    ]);

    return fullObs;
  }

  /**
   * Starts a new Claude Code session.
   */
  public startSession(session: Omit<LocalSession, "startedAt">): LocalSession {
    const startedAt = Date.now();
    const fullSession: LocalSession = {
      ...session,
      startedAt,
    };

    this.db.run(`INSERT OR REPLACE INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)`, [
      fullSession.id,
      fullSession.project,
      fullSession.cwd,
      fullSession.startedAt,
    ]);

    return fullSession;
  }

  /**
   * Concludes a session and records its summary.
   */
  public endSession(id: string, summary: string): void {
    const endedAt = Date.now();
    const cleanSummary = sanitizeContent(summary);

    this.db.run(`UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?`, [endedAt, cleanSummary, id]);
  }

  /**
   * Gets the most recent session for a project.
   */
  public getRecentSession(project: string): LocalSession | null {
    const row = this.db
      .query(`SELECT id, project, cwd, started_at, ended_at, summary FROM sessions WHERE project = ? ORDER BY started_at DESC LIMIT 1`)
      .get(project) as { id: string; project: string; cwd: string; started_at: number; ended_at?: number; summary?: string } | null;

    if (!row) return null;
    return {
      id: row.id,
      project: row.project,
      cwd: row.cwd,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      summary: row.summary,
    };
  }

  /**
   * Gets recent observations (e.g. for context injection).
   */
  public getRecentObservations(project: string, limit: number = 5): LocalObservation[] {
    const rows = this.db
      .query(
        `SELECT id, session_id, project, tool_name, title, content, is_error, created_at
         FROM observations
         WHERE project = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(project, limit) as Array<{
      id: string;
      session_id: string;
      project: string;
      tool_name: string;
      title: string;
      content: string;
      is_error: number;
      created_at: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      project: r.project,
      toolName: r.tool_name,
      title: r.title,
      content: r.content,
      isError: r.is_error === 1,
      createdAt: r.created_at,
    }));
  }

  /**
   * Searches entries and observations using FTS5 trigram or LIKE fallback.
   */
  public search(query: string, project?: string, limit: number = 10): SearchResult[] {
    const q = query.trim();
    if (!q) {
      // Return recent entries if query is empty
      const queryStr = project
        ? `SELECT id, project, kind, title, content, target_tables, tags, created_at FROM entries WHERE project = ? ORDER BY updated_at DESC LIMIT ?`
        : `SELECT id, project, kind, title, content, target_tables, tags, created_at FROM entries ORDER BY updated_at DESC LIMIT ?`;
      const params = project ? [project, limit] : [limit];
      const rows = this.db.query(queryStr).all(...params) as any[];

      return rows.map((r) => ({
        id: r.id,
        source: "local",
        kind: r.kind,
        title: r.title,
        content: r.content,
        targetTables: r.target_tables ? JSON.parse(r.target_tables) : [],
        tags: r.tags ? JSON.parse(r.tags) : [],
        createdAt: r.created_at,
      }));
    }

    // Try FTS5 trigram query first
    try {
      // Escape special SQLite FTS query characters
      const escaped = q.replace(/['"*]/g, " ").trim();
      if (escaped.length >= 3) {
        const rows = this.db
          .query(
            `SELECT f.id, f.kind, f.title, f.content, bm25(fts) as score
             FROM fts(?) f
             ORDER BY score ASC
             LIMIT ?`,
          )
          .all(escaped, limit) as Array<{ id: string; kind: string; title: string; content: string; score: number }>;

        if (rows.length > 0) {
          return rows.map((r) => ({
            id: r.id,
            source: "local",
            kind: r.kind as any,
            title: r.title,
            content: r.content,
            score: r.score,
            createdAt: Date.now(),
          }));
        }
      }
    } catch {
      // Trigram query syntax error, fallback to LIKE
    }

    // Fallback LIKE search on entries & observations
    const likePattern = `%${q}%`;
    const entryRows = this.db
      .query(
        `SELECT id, kind, title, content, created_at
         FROM entries
         WHERE (title LIKE ? OR content LIKE ?)
         LIMIT ?`,
      )
      .all(likePattern, likePattern, limit) as any[];

    return entryRows.map((r) => ({
      id: r.id,
      source: "local",
      kind: r.kind,
      title: r.title,
      content: r.content,
      createdAt: r.created_at,
    }));
  }

  public close(): void {
    this.db.close();
  }
}
