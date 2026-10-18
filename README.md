# engram

**Automatic working memory for data analysts in Claude Code, with optional team sharing.**

engram records the queries you run and the errors you hit while working with Claude Code. When a
later prompt touches the same tables or problems, it adds the matching memories to that prompt.
If you want, you can promote a memory into a Markdown file that your team reviews in git.

- **Automatic capture**: Bash commands and SQL sent through MCP tools, including failures, are
  stored locally after secrets are redacted. Query results and command output are never stored.
- **Error → fix pairs**: when a failing command is followed by a similar command that works, engram
  saves the pair as a durable `fix` note. Example: `Unrecognized name: signup_dt` followed by a query
  that uses `signup_date`.
- **Recall on every prompt**: matching notes, fixes, past errors and team items are added to the
  prompt (up to about 1.5 KB, and only when something matches).
- **Session recap**: a new session starts with what the previous session in the same repository was
  about.
- **Team sharing (optional)**: `/engram:share` writes a note as Markdown into a team git repository.
  Every teammate's session gets an index of those files.
- **No runtime dependencies**: one bundled `dist/cli.mjs` running on Node.js 18 or newer. No npm
  install, no native modules, no server.

## Requirements

- Claude Code
- Node.js 18 or newer on `PATH` (`node -v`). If you installed Claude Code with npm, you already have it.

## Install

```bash
claude plugin marketplace add hidenobunagai/engram
claude plugin install engram@engram-marketplace
```

Or, inside Claude Code: `/plugin marketplace add hidenobunagai/engram`, then `/plugin install engram@engram-marketplace`.

## Commands

| Command                   | What it does                                                             |
| ------------------------- | ------------------------------------------------------------------------ |
| `/engram:recall <words>`  | Search memory and team knowledge                                         |
| `/engram:save <finding>`  | Save a caveat, metric definition, query, decision, fact or fix           |
| `/engram:share <note-id>` | Write a saved note as a team Markdown file (you commit it and open a PR) |
| `/engram:status`          | Show what is stored, the team stores in use, and any invalid team files  |

Claude can call `recall` and `save` on its own when they fit, for example before writing SQL against a
table it saw fail earlier.

## What is stored, and where

Personal memory lives in `~/.claude/engram-memory/` (set `ENGRAM_HOME` to move it). This folder is
outside the plugin's install folder, so uninstalling the plugin does not delete it.

| File                            | Content                                                                               | Kept                              |
| ------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------- |
| `obs/<project>/<session>.jsonl` | One line per prompt or tool call: the command or SQL, and the error text if it failed | 90 days (`ENGRAM_RETENTION_DAYS`) |
| `notes.jsonl`                   | Saved notes and automatic fixes                                                       | Until `forget`                    |
| `recaps/<project>.json`         | First and last prompt plus Claude's last reply of the latest session                  | Overwritten                       |

`<project>` is derived from the git repository root, so subfolders of one repository share a single memory.

**Not stored**: command output, query results, file contents. This keeps customer rows out of the memory.
For failed calls, the error message is stored (head and tail, at most 1,000 characters). Some database
errors quote the offending value, so redaction also runs on it.

**Redaction**: database URIs with passwords, `password=`/`token=`-style values (including JSON keys and
`*_PASSWORD` env vars), `mysql -p…`, `curl -u user:pass`, PEM private keys, Authorization headers, JWTs,
AWS, GitHub, OpenAI, Anthropic, Stripe, Slack, Google, GitLab and Databricks keys, secrets stated in prose
("the password is …", "パスワードは…"), email addresses, phone numbers and card numbers are replaced before
anything is written. Regex redaction is best effort, not a guarantee. Other personal data such as customer IDs or
names inside SQL literals is not detected.

**Network**: engram makes no network calls. Text it injects into prompts is sent to the model like any
other context.

Set `ENGRAM_DISABLE_CAPTURE=1` to stop recording while keeping recall.

## Team knowledge (optional)

engram reads team Markdown files from the first of:

1. `ENGRAM_TEAM_DIR`, if set (only this store is used)
2. the nearest `.engram/` folder between the current directory and the repository root, plus
   `~/.claude/engram-team/` if that exists

A common setup is one shared repository cloned to `~/.claude/engram-team`:

```bash
git clone git@github.com:your-company/analytics-knowledge.git ~/.claude/engram-team
```

engram does not pull for you. Run `git pull` there now and then, or schedule it.

Layout and format (see `examples/team/`):

```
caveats/  metrics/  queries/  decisions/  facts/  fixes/  notes/
```

```markdown
---
id: "cav-users-soft-deletes"
kind: "caveat"
title: "Soft deletes in dim_users"
summary: "dim_users keeps deleted accounts; filter deleted_at IS NULL for active users."
target_tables: ["dim_users", "fct_orders"]
tags: ["users", "retention"]
status: "active" # "deprecated" hides the item
---

Details, SQL, and rationale.
```

`id` and `title` are required. Files without them are skipped and listed by `/engram:status`.

## Development

Development uses bun. The shipped artifact is plain Node.js.

```bash
bun install
bun run test        # builds dist/cli.mjs, then runs unit and Node end-to-end tests
NODE_BIN=/path/to/node18 bun test tests/e2e.test.ts
```

`dist/cli.mjs` is committed because plugin installs do not run a build. Rebuild it with `bun run build`
before committing source changes.

## License

MIT
