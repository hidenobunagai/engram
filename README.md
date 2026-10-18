# engram 🧠

**Team Memory & Knowledge Base for Data Analysts in Claude Code.**

`engram` helps data analyst teams eliminate recurring mistakes, retain business metric definitions, and share data caveats directly inside Claude Code.

---

## ✨ Features

- **🛡️ Data Caveats & Traps**: Remind Claude automatically about table quirks, NULL behavior, tracking outages, and JOIN pitfalls before queries are generated.
- **📐 Canonical Metric Definitions**: Maintain team-wide KPI calculation rules with tested SQL snippets.
- **🤝 Two-Tier Architecture**:
  - **Local Tier (Private SQLite)**: Zero-server personal working memory, error observations, and query histories.
  - **Git Tier (`.engram/`)**: Markdown files for team-reviewed definitions, reviewed via Pull Requests.
- **🔒 Privacy & Secret Masking**: Auto-redacts database credentials, tokens, and API keys. Completely local-first with zero external API calls.
- **⚡ Native Claude Code Integration**: Hooks into `session.start`, `turn.step`, and `session.end` with slash commands and agent tools.

---

## 🚀 Quick Start

### Installation via Claude Code Plugin Marketplace

You can install `engram` directly inside Claude Code:

```bash
# In Claude Code chat:
/plugin install engram --marketplace hidenobunagai/engram
```

Or from your terminal:

```bash
claude plugin marketplace add hidenobunagai/engram
claude plugin install engram@engram-marketplace
```

### Development Setup

Clone the repository and install dependencies with `bun`:

```bash
bun install
bun test
```

### Knowledge Store Architecture (Global-First & Hierarchical)

Data analysts frequently switch between multiple directories (ad-hoc queries, dbt, notebooks, scripts), but query the **same company data warehouse**.

`engram` supports a **Hierarchical Knowledge Store**:

1. **Global Store (`~/.claude/engram`) [Default & Recommended]**:
   - Always active across all folders on your machine.
   - Ideal for team-wide DWH caveats, table quirks, and KPI definitions.
2. **Project Store (`./.engram/`) [Optional]**:
   - If present in the current working directory, project-level items are automatically merged (and can override global items with matching IDs).
3. **Environment Variable (`ENGRAM_DIR`)**:
   - Overrides search paths to point directly to any shared folder or cloned repo.

#### Recommended Team Workflow:

Create a single central Git repository for your data analyst team's knowledge:

```bash
# Clone your team's knowledge repository directly to ~/.claude/engram:
git clone git@github.com:your-company/dwh-knowledge.git ~/.claude/engram
```

Now, wherever you open Claude Code on your PC, all team metrics and data caveats are instantly loaded!

```
~/.claude/engram/ (or your-analytics-repo/.engram/)
├── caveats/      # Known data traps & table quirks
│   └── dim_users_soft_deletes.md
├── metrics/      # Official KPI definitions & formulas
│   └── monthly_active_users.md
├── queries/      # Peer-reviewed golden SQL queries
│   └── cohort_retention.md
└── decisions/    # Analytical methodologies & agreements
    └── fy26_churn_window.md
```

### Commands in Claude Code

- `/engram:recall <query>`: Search both local history and team caveats/metrics.
- `/engram:caveat <title>`: Record a new data quirk into `.engram/caveats/`.
- `/engram:metric <name>`: Create or update a KPI definition.
- `/engram:share`: Convert insights from the current session into shareable `.engram/` files.
- `/engram:status`: Check current knowledge base statistics.

---

## 📄 License

MIT
