# engram

**Automatic working memory for data analysts in Claude Code, with optional team sharing.**

engram records the queries you run and the errors you hit while working with Claude Code. When a
later prompt touches the same tables or problems, it adds the matching memories to that prompt.
If you want, you can promote a memory into a Markdown file that your team reviews in git.

- **Automatic capture**: prompts, Bash commands, SQL sent through MCP tools, and files Claude writes
  or edits (with the new text for code files such as `.sql` and `.py`), including failures, are stored
  locally after secrets are redacted. Query results and command output are never stored.
- **Error → fix pairs**: when a failing command is followed by a similar command that works, engram
  saves the pair as a durable `fix` note. Example: `Unrecognized name: signup_dt` followed by a query
  that uses `signup_date`.
- **Recall on every prompt**: matching notes, fixes, past errors and team items are added to the
  prompt (up to about 1.5 KB, and only when something matches).
- **Session recap and history**: a new session starts with what the previous session in the same
  repository was about and the latest notes saved there. `/engram:history` lists past sessions and
  shows what happened in one session or on one day.
- **Team sharing (optional, scoped)**: `/engram:share` publishes a note as Markdown into a shared
  folder (a network drive or a git clone), and teammates' sessions get an index of those files. Only
  the projects you select take part, so a session about your own PC setup is never shared and never
  sees team knowledge.
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

| Command                      | What it does                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `/engram:recall <words>`     | Search memory and team knowledge                                                        |
| `/engram:save <finding>`     | Save a caveat, metric definition, query, decision, fact or fix                          |
| `/engram:share [note-id]`    | List shareable notes, preview one, and publish it to the team folder after you confirm  |
| `/engram:scope [on\|off]`    | Show, select or unselect this project for team sharing                                  |
| `/engram:history [id\|date]` | List past sessions (`--all` for every project), or show one session's or day's timeline |
| `/engram:status`             | Show what is stored, the team scope of this project, and any invalid team files         |

Claude can call `recall` and `save` on its own when they fit, for example before writing SQL against a
table it saw fail earlier.

## What is stored, and where

Personal memory lives in `~/.claude/engram-memory/` (set `ENGRAM_HOME` to move it). This folder is
outside the plugin's install folder, so uninstalling the plugin does not delete it.

| File                            | Content                                                                               | Kept                                   |
| ------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| `obs/<project>/<session>.jsonl` | One line per prompt or tool call: the command or SQL, and the error text if it failed | 90 days (`ENGRAM_RETENTION_DAYS`)      |
| `notes.jsonl`                   | Saved notes and automatic fixes                                                       | Until `engram forget <id>` erases them |
| `recaps/<project>.json`         | First and last prompt plus Claude's last reply of the latest session                  | Overwritten                            |

`<project>` is derived from the git repository root, so subfolders of one repository share a single memory.

**Not stored**: command output, query results, the contents of files Claude reads, and the contents of
data files it writes (only their path). This keeps customer rows out of the memory. Saving an identical
note again refreshes it instead of duplicating it.
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

Team knowledge is a folder of Markdown files that everyone can read: a shared network drive, or a git
clone if your team prefers pull requests.

### 1. Point engram at the shared folder

In Claude Code, run `/plugin`, open engram and set **Team folder**, for example `S:\analytics\engram`
or `\\fileserver\analytics\engram`. From a terminal:

```bash
echo '{"team_dir": "S:\\analytics\\engram"}' | claude plugin configure engram@engram-marketplace --values-stdin
```

engram remembers the folder in its data dir, so commands run outside hooks use it too. `ENGRAM_TEAM_DIR`
overrides it. Without a configured folder, `~/.claude/engram-team` is used if it exists.

### 2. Choose which projects take part

Once a team folder exists, a project is out of the team scope until you pick it. Run this inside a
project:

```
/engram:scope on      # include this project (its folder, and other clones of the same git remote)
/engram:scope off     # take it out again
/engram:scope         # show the verdict and the reason
```

A project is also in scope when it has a `.engram/` folder, or when the team folder's optional
`scope.json` lists it:

```json
{ "projects": ["github.com/acme-analytics/*"], "paths": ["~/analysis/*"] }
```

`projects` match the git remote (`git@github.com:acme-analytics/kpi.git` is compared as
`github.com/acme-analytics/kpi`), `paths` match the project folder, and `*` matches anything.

In scope, team knowledge is injected and notes saved there can be shared. Out of scope (for example a
session about your PC setup), nothing from the team folder is injected and `/engram:share` refuses the
notes saved there.

### 3. Share

`/engram:share` lists notes you can share. `/engram:share <id>` shows a preview, and the file is written
to the team folder only after you confirm (`--yes`). Teammates see it from their next session. In a
git-backed folder, commit and push as usual.

### Slow or offline network drives

Prompt-time hooks never read the team folder. They use a local snapshot of it, which background hooks
refresh at session start and after each reply (at most every 10 minutes). If the drive is offline,
engram keeps using the last snapshot. `/engram:status`, `/engram:scope` and `/engram:share` read the
folder directly and report it when it cannot be reached.

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
