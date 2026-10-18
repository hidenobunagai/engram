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
claude plugin install engram
```

### Development Setup

Clone the repository and install dependencies with `bun`:

```bash
bun install
bun test
```

### Repository Structure for `.engram/`

In your data repository, `engram` manages knowledge under `.engram/`:

```
your-analytics-repo/
├── .engram/
│   ├── caveats/      # Known data traps & table quirks
│   │   └── dim_users_soft_deletes.md
│   ├── metrics/      # Official KPI definitions & formulas
│   │   └── monthly_active_users.md
│   ├── queries/      # Peer-reviewed golden SQL queries
│   │   └── cohort_retention.md
│   └── decisions/    # Analytical methodologies & agreements
│       └── fy26_churn_window.md
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
