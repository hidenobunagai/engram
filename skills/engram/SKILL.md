---
name: engram
description: Team memory and knowledge base for data analysts. Manages data caveats, table quirks, official metrics, golden SQL queries, and session history via .engram/ and local SQLite.
argument-hint: "[recall|status|caveat|metric|share] <query>"
user-invocable: true
---

# engram 🧠

Team memory and knowledge base for data analysts in Claude Code.

## Commands

| Command                                 | Action         | Description                                                                    |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| `/engram status`                        | Status check   | Shows loaded caveats, metrics, and local session stats                         |
| `/engram recall <query>`                | Search         | Searches both Git-backed team knowledge (`.engram/`) and local session history |
| `/engram caveat <title> \| <details>`   | Record caveat  | Saves a table trap/quirk to `.engram/caveats/` ready for Git commit            |
| `/engram metric <name> \| <definition>` | Record metric  | Saves an official KPI definition to `.engram/metrics/`                         |
| `/engram share`                         | Session export | Guides exporting insights from the current session into `.engram/`             |

---

## Instructions for Claude

When the user runs `/engram` or asks about data caveats/metrics:

1. **When invoked with arguments**:
   - `status`: Run `bun "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" status` or inspect `.engram/` and report current knowledge count.
   - `recall <query>`: Run `bun "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" recall "<query>"` and present findings grouped by Team Git Knowledge vs Local.
   - `caveat <text>`: Save a new caveat Markdown file under `.engram/caveats/<slug>.md` with frontmatter (`id`, `kind: caveat`, `target_tables`, `created_at`).
   - `metric <text>`: Save a new metric definition under `.engram/metrics/<slug>.md` with formula and SQL logic.
   - `<general query>`: Treat as a recall search query across `.engram/` and past sessions.

2. **Autonomous Proactive Behavior (Crucial for Data Analysts)**:
   - Before writing complex SQL queries or joins, check `.engram/caveats/` for target tables (e.g. soft deletes, NULL columns, tracking outages).
   - If an official definition exists in `.engram/metrics/`, follow its calculation rules instead of inventing custom formulas.
   - Remind the user about relevant table caveats before executing analytical queries.
