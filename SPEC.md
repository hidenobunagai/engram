# engram: Team Memory & Knowledge Base for Data Analysts in Claude Code

## 1. Overview & Motivation

`engram` is a privacy-first, zero-overhead memory and knowledge base plugin designed for Data Analyst teams using Claude Code.

While software engineers primarily track code structure and dependencies, data analysts face a different set of challenges:

- **Data Caveats (Traps & Quirks)**: Undocumented NULL behavior, historical tracking outages, duplicate records, deleted flag logic.
- **Metric Definitions**: Discrepancies in KPI calculations (e.g., active user definitions, ARR exclusions, churn window).
- **Golden Queries**: Hard-won, peer-reviewed SQL snippets with complex window functions or CTEs that shouldn't be reinvented.
- **Analytical Decisions**: Context behind outlier filtering, date window choices, and stakeholder agreements.

`engram` unifies personal daily workflow memory with team-wide collective intelligence via a **Two-Tier Architecture**.

---

## 2. Two-Tier Architecture

```
                  ┌─────────────────────────────────────┐
                  │          Claude Code Session        │
                  └──────────────────┬──────────────────┘
                                     │
             ┌───────────────────────┴───────────────────────┐
             ▼                                               ▼
   【Tier 1: Personal Local】                      【Tier 2: Team Git】
     ~/.claude/engram/local.db                       <repo>/.engram/
    (Fast, Embedded SQLite FTS5)                    (Markdown / YAML in Git)
┌─────────────────────────────────┐             ┌─────────────────────────────────┐
│ • Daily working memory & errors │             │ • metrics/  (Official KPI defs) │
│ • Observed queries & executions │             │ • caveats/  (Known data quirks) │
│ • Auto-masked secrets           │             │ • queries/  (Golden SQLs)       │
│ • No noise committed to git     │             │ • decisions/(Agreed logic)      │
└─────────────────────────────────┘             └─────────────────────────────────┘
                                                           │
                                                           ▼ (git commit & push)
                                                  Shared across the entire team!
```

### Tier 1: Personal Working Memory (Local SQLite)

- **Zero-ops & Zero-Server**: No background daemon (like a Raspberry Pi or cloud server). Runs embedded using `bun:sqlite` with FTS5 trigram indexing.
- **Automatic Capture**: Automatically tracks executed queries, script errors, and solutions within the user's local sessions.
- **Private & Safe**: Never pushed to git. Automatically sanitizes database connection strings, passwords, and API keys before saving.

### Tier 2: Team Curated Knowledge (Git-backed `.engram/`)

- **Version Controlled**: Stored as human-readable Markdown files with YAML frontmatter inside the repository's `.engram/` directory.
- **Collaborative Review**: Team members update metrics and data caveats via normal Pull Requests.
- **Automatic Context Injection**: At the start of every Claude Code session (`session.start`), `engram` scans `.engram/` and injects verified business rules and data traps directly into Claude's prompt context.

---

## 3. Data Model for Analysts

### Knowledge Types (`kind`)

1. **`caveat`** (Data traps & table quirks)
   - Target tables/columns, outage timeframes, join risks, and recommended filters.
2. **`metric`** (KPI & business logic definitions)
   - Calculation formulas, SQL fragments, aggregation grains, and business rationale.
3. **`query`** (Golden / Canonical SQL)
   - Tested analytical queries, complex CTEs, dashboard base queries.
4. **`decision`** (Analytical decisions & assumptions)
   - Why certain cohorts were excluded, methodology choices, stakeholder sign-offs.
5. **`fact`** (Data warehouse schema & pipeline facts)
   - Table update cadence, SLA, grain, source upstream systems.

### Git File Format (`.engram/<kind>/<slug>.md`)

````markdown
---
id: cav-users-deleted-at
kind: caveat
title: Soft deletes in dim_users
target_tables: ["dim_users", "fct_orders"]
author: analyst-jane
created_at: 2026-10-18
tags: ["users", "retention", "joins"]
---

### Problem

`dim_users` contains soft-deleted users where `is_deleted = true` or `deleted_at IS NOT NULL`.
Joining `dim_users` without filtering out deleted users causes inflated cohort counts.

### Recommended Pattern

```sql
SELECT ...
FROM dim_users u
WHERE u.deleted_at IS NULL
```
````

```

---

## 4. Security & Sanitization

1. **Local-First & No Outbound Calls**:
   - All searches (FTS5 trigram) run in-process on the local machine.
   - Does not send internal schema or queries to third-party compression APIs.
2. **Secret Redaction**:
   - Automated regex masking for:
     - Database connection strings (`postgresql://...`, `snowflake://...`, `bigquery://...`)
     - API keys, JWTs, Bearer tokens, AWS access keys, private keys
     - Replaces secrets with `[REDACTED_SECRET]` before writing to local DB or `.engram/`.
3. **Project Isolation**:
   - Local DB partitions session observations by repository root hash to avoid cross-project contamination.

---

## 5. Claude Code Plugin Lifecycle

### Hooks
- **`session.start`**:
  - Scans `<repo>/.engram/` for metrics, caveats, and golden queries.
  - Injects top relevant caveats and recent session context into the conversation.
- **`turn.step`**:
  - Observes tool use: SQL query runs, python script runs, error messages, and successful fixes.
  - Sanitizes and stores them into the local observations table.
- **`session.end`**:
  - Summarizes key takeaways and updates session metadata.

### Slash Commands
- `/engram:recall <query>`: Cross-searches local session history and git-backed team knowledge.
- `/engram:caveat <table-or-title>`: Quickly records a new data trap into `.engram/caveats/` ready for git commit.
- `/engram:metric <metric-name>`: Drafts an official metric definition with SQL logic.
- `/engram:share`: Interactive wizard to export valuable findings from the current session into `.engram/` files.
- `/engram:status`: Displays loaded caveats, metrics, and local session stats.

### Agent Tools
- `engram_recall(query, kind?, limit?)`: Agent tool to search data caveats and metrics before executing queries.
- `engram_save(kind, title, content, tables?, tags?)`: Agent tool to persist a new insight.
```
