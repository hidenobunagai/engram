# engram

**Automatic working memory for data analysts in Claude Code, with optional team sharing.**

engram records the queries you run and the errors you hit while working with Claude Code. When a
later prompt touches the same tables or problems, it adds the matching memories to that prompt.
If you want, you can promote a memory into a Markdown file that your team reviews in git.

- **Automatic capture**: prompts, Bash commands, SQL sent through MCP tools, and files Claude writes
  or edits (with the new text for code files such as `.sql` and `.py`), including failures, are stored
  locally after secrets are redacted. What a tool returns (query results, command output) is never
  stored, and rows of data inside a captured command or prompt are replaced with `[N data rows
omitted]`. Two things can still carry a value from your data: the error text of a failed call, and
  the first sentence of Claude's last reply kept in the session recap (see
  [What is stored, and where](#what-is-stored-and-where)).
- **Error → fix pairs**: when a failing command is followed by a similar command that works, engram
  saves the pair as a durable `fix` note. Example: `Unrecognized name: signup_dt` followed by a query
  that uses `signup_date`.
- **Recall on every prompt**: matching notes, fixes, past errors and team items are added to the
  prompt (up to 1.5 KB of UTF-8, and only when something matches). A note about a table the prompt names
  is always a candidate, and nothing is repeated within one session. After `/compact`, the session's
  own fixes and latest errors are brought back.
- **Check when a query runs**: when Claude is about to run SQL (Bash or an MCP tool), a hook looks up
  the caveats and fixes saved for the tables it reads, including a warning when the query uses a column
  that failed before. The hook runs before the call; Claude reads the warning next to the call's result.
- **Memory stays with its project**: notes and fixes are recalled in the project they were saved in.
  A rule that holds everywhere (a warehouse-wide metric definition) can be saved with `--global`, and
  `/engram:recall <words> --all` searches every project on purpose. A consultant's client-A caveat
  never surfaces in client B's repository.
- **Automatic fixes fade out**: a fix engram paired on its own leaves prompt injection once nobody was
  shown it for 90 days, or after it was shown 10 times without its error coming back. It stays
  searchable, and the same error being paired again brings it back. Notes you saved never fade.
- **Session recap and history**: a new session starts with what the previous session in the same
  repository was about and the latest notes saved there. The note count names this project first and
  adds how many belong to other projects, which stay out of this project's prompts.
  `/engram:history` lists past sessions and
  shows what happened in one session or on one day.
- **Team sharing (optional, scoped)**: `/engram:share` publishes a note as Markdown into a shared
  folder (a network drive or a git clone), and teammates' sessions get an index of those files. Only
  the projects you select take part, so a session about your own PC setup is never shared and never
  sees team knowledge.
- **No runtime dependencies**: one bundled `dist/cli.mjs` running on Node.js 18 or newer. No npm
  install, no native modules, no server.

## How engram differs from Claude Code's built-in memory

Claude Code's own memory is a set of files (`CLAUDE.md` and the notes Claude keeps for itself) that
are read at session start rather than picked per prompt. They are good for rules you want applied
everywhere, and you curate them. engram is a different layer:

|                         | Built-in memory                 | engram                                                                                    |
| ----------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| How it fills            | You (or Claude) write it        | Every prompt, command, SQL call and failure is captured automatically                     |
| What reaches the prompt | What is loaded at session start | Only the few records that match this prompt or the query about to run, within 1.5 KB      |
| Errors                  | Whatever someone wrote down     | A failed query followed by the one that worked becomes a `fix` note on its own            |
| Tables                  | Plain text                      | Notes know their tables; a query on a table brings its caveats and known-bad columns up   |
| Ageing                  | Stays until edited              | Automatic fixes fade out of prompts when unused or unconfirmed; your saved notes never do |
| Scope                   | User, project or local file     | Per project by default, `--global` on purpose; team items only in selected projects       |
| Sharing                 | Commit the file                 | Promote one note at a time into a reviewed Markdown folder                                |

Use both: put standing rules in `CLAUDE.md`, and let engram remember what happened.

## What recall looks like

After a session where `SELECT signup_dt …` failed with `Unrecognized name: signup_dt`, the next query
used `signup_date`, and the caveat below was saved, a new session's prompt

```
How many active users signed up per month in dim_users this year?
```

gets this block added (the real output of the prompt hook):

```
engram: records from earlier sessions and team knowledge that match this prompt (may be outdated; verify before relying on them):
- [caveat 2026-10-27 caveat-5b7b0b6c] dim_users keeps soft-deleted accounts: Rows stay after an account is deleted; filter deleted_at IS NULL for active users.
- [fix 2026-10-27 fix-79731ed0] Fix: Error in query: Unrecognized name: signup_dt at [1:8]: worked: bq query --use_legacy_sql=false 'SELECT signup_date, count(*) FROM analytics.dim_users GROUP BY 1'
- [past run 2026-10-27] bq query --use_legacy_sql=false 'SELECT country, count(*) FROM analytics.dim_users WHERE deleted_at IS NULL GROUP BY 1'
```

If Claude then runs `bq query 'SELECT signup_dt FROM analytics.dim_users'` anyway, the query check
adds `… — this query uses signup_dt again` to that fix next to the call's result.

## Requirements

- Claude Code
- Node.js 18 or newer (`node -v`). If you installed Claude Code with npm, you already have it.
  Hooks start through `hooks/run-hook.sh`, which finds Node even when the hook's `PATH` lacks it
  (the macOS app runs hooks with `/usr/bin:/bin:...`): `ENGRAM_NODE` → `node` on `PATH` → newest
  nvm install → Homebrew/system Node → bun. Set `ENGRAM_NODE` to a full path if none of those match.
  Without any interpreter the hooks exit 127 with a message instead of silently doing nothing.
  The `/engram:*` slash commands start the CLI through the same script, so they work wherever the
  hooks do.

## Install

```bash
claude plugin marketplace add hidenobunagai/engram
claude plugin install engram@engram-marketplace
```

Or, inside Claude Code: `/plugin marketplace add hidenobunagai/engram`, then `/plugin install engram@engram-marketplace`.

## Commands

| Command                      | What it does                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `/engram:recall <words>`     | Search this project's memory and team knowledge (`--all`: every project's notes)        |
| `/engram:save <finding>`     | Save a caveat, metric definition, query, decision, fact or fix                          |
| `/engram:share [note-id]`    | List shareable notes, preview one, and publish it to the team folder after you confirm  |
| `/engram:scope [on\|off]`    | Show, select or unselect this project for team sharing                                  |
| `/engram:history [id\|date]` | List past sessions (`--all` for every project), or show one session's or day's timeline |
| `/engram:table <name>`       | Everything known about one table: notes, common errors, the fixes for them, last use    |
| `/engram:status`             | Show what is stored, the team scope, invalid team files, and recent hook errors         |

Claude can call `recall` and `save` on its own when they fit, for example before writing SQL against a
table it saw fail earlier.

`/engram:status` also shows when this project last captured anything and how many hook failures
`error.log` holds, with the latest ones when any happened in the past 7 days. A capture that stopped
long ago, or a fresh warning, means the hooks are failing.

### From a terminal

Every command also runs from a shell. `/engram:status` prints the exact line to use (`terminal
commands: sh "…/hooks/run-hook.sh" <command>`); an alias makes it `engram`:

```bash
alias engram='sh "/path/from/status/hooks/run-hook.sh"'
```

```bash
engram recall <words> [--all] [--limit N]  # search; --all includes every project's notes
engram save --kind caveat --title "…" --tables a,b [--global] --body "…"
engram table <name>              # the table card
engram stats                     # disk use, records by kind and source, lifecycle, top tables
engram history [<session|YYYY-MM-DD>] [--all]
engram forget <note-id>          # erase one note
engram purge <regex|obs-id>      # delete matching observations, notes and recaps; prints a count per store
engram resanitize                # re-apply the current redaction rules to everything already stored
engram share <note-id> --yes [--update] [--to DIR]
engram status
```

`resanitize` is the one to run after upgrading, because a rule added in a new version also cleans records
written before it existed.

## What is stored, and where

Personal memory lives in `~/.claude/engram-memory/` (set `ENGRAM_HOME` to move it). This folder is
outside the plugin's install folder, so uninstalling the plugin does not delete it.

| File                               | Content                                                                               | Kept                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| `obs/<project>/<session>.jsonl`    | One line per prompt or tool call: the command or SQL, and the error text if it failed | 90 days (`ENGRAM_RETENTION_DAYS`)      |
| `obs/<project>/<session>.injected` | Ids of memories already shown in that session, so they are not repeated               | Same as the session's log              |
| `notes.jsonl`                      | Saved notes and automatic fixes                                                       | Until `engram forget <id>` erases them |
| `hits.jsonl`                       | When each note was added to a prompt, for the fade-out of automatic fixes             | Compacted at session start             |
| `recaps/<project>/<session>.json`  | First and last prompt plus the first sentence of Claude's last reply                  | 90 days; the newest per project stays  |
| `error.log`                        | Hook failures with their stack                                                        | Cut to its newest half past 256 KB     |
| `index/<project>/`                 | Search index over the observations, rebuilt from them whenever it is stale            | Safe to delete at any time             |

`<project>` is derived from the project root, so subfolders of one project share a single memory. The
root is the nearest folder above the working directory that holds `.git` or `.jj`; outside a
repository, the nearest one that holds `.engram/`, `dbt_project.yml` or `pyproject.toml`. A marker
inside a repository does not split it (a dbt folder in a monorepo belongs to the monorepo). Your home
folder never counts as a root, so a dotfiles repository or a stray `pyproject.toml` there cannot merge
every project below it; without a marker, the working directory itself is the project.

**Not stored**: command output, query results, the contents of files Claude reads, and the contents of
files it writes that are not code (only their path). That covers a written `.md` report and a data file,
so findings and customer rows stay out of the memory.
A captured command or prompt keeps its head line, and a run of three or more rows that share the same
number of delimiters is replaced with `[N data rows omitted]`, so a heredoc body or a pasted extract
loses its rows. The recap keeps only the first sentence of Claude's last reply.
Saving an identical note again refreshes it instead of duplicating it, and `notes.jsonl` is
compacted (superseded lines dropped) at session start once they outnumber the live notes.
For failed calls, the error message is stored (head and tail, at most 1,000 characters). Some database
errors quote the offending value, so redaction also runs on it.

**Redaction**: database URIs with passwords, `password=`/`token=`-style values (including JSON keys and
`*_PASSWORD` env vars), `mysql -p…`, `curl -u user:pass`, `sshpass -p …`, secret-bearing CLI flags such as
`--db-password` and `--api-token`, PEM private keys, Authorization, `Cookie` and `Set-Cookie` headers, JWTs,
AWS, GitHub, GitLab, Google OAuth (`ya29.`, `GOCSPX-`), Hugging Face, npm, SendGrid, Databricks, OpenAI,
Anthropic, Stripe, Slack and Google keys, secrets stated in prose
("the password is …", "パスワードは…"), My Numbers written next to their label with a valid check digit,
email addresses, phone numbers and card numbers are replaced before
anything is written. Regex redaction is best effort, not a guarantee. Other personal data such as customer IDs or
names inside SQL literals is not detected.

**Network**: engram makes no network calls. Text it injects into prompts is sent to the model like any
other context.

Set `ENGRAM_DISABLE_CAPTURE=1` to stop recording while keeping recall. To stop capture for one project
instead, add an empty `.engram-ignore` file at its root (next to `.git`): hooks then record nothing for that
project, recall keeps working, and `engram status` shows `capture: off (.engram-ignore at the project root)`.
The same file makes engram ignore that repository's own `.engram/` team folder (see below).

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

A project is also in scope when the team folder's optional `scope.json` lists it:

```json
{ "projects": ["github.com/acme-analytics/*"], "paths": ["~/analysis/*"] }
```

`projects` match the git remote (`git@github.com:acme-analytics/kpi.git` is compared as
`github.com/acme-analytics/kpi`), `paths` match the project folder, and `*` matches anything.

> **A repository with a `.engram/` folder joins the team scope on its own.** Cloning one is enough:
> its Markdown files are injected into your prompts like team knowledge, and notes saved there can be
> shared into it, without `/engram:scope on`. This is the same trust you give a repository's
> `CLAUDE.md`, so treat a `.engram/` folder in a repository you do not trust the same way. To opt one
> repository out, create an empty `.engram-ignore` at its root (add it to `.git/info/exclude` to keep
> it out of commits): engram then ignores that repository's `.engram/` and stops capturing there.

In scope, team knowledge is injected and notes saved there can be shared. Out of scope (for example a
session about your PC setup), nothing from the team folder is injected and `/engram:share` refuses the
notes saved there.

### 3. Share

`/engram:share` lists notes you can share. `/engram:share <id>` shows a preview, and the file is written
to the team folder only after you confirm (`--yes`). Teammates see it from their next session. In a
git-backed folder, commit and push as usual.

A new file is created exclusively: if a teammate publishes an item with the same title at the same
moment, the later one gets a `-2` suffix instead of replacing it. Replacing the file that already holds
an id (`--yes --update`) writes a temp file and renames it, so nobody reads half a file.

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

## Your data: inspect, export, delete

Everything personal sits in one folder, `~/.claude/engram-memory/` (or `ENGRAM_HOME`), as plain JSONL
and JSON files; team files live in the team folder and in repositories' `.engram/` folders, never in
the personal store.

- **Inspect**: `/engram:status` (what is stored and loaded), `engram stats` (disk use, counts, top
  tables), `/engram:history` (what each session recorded), `/engram:recall` and `/engram:table`. The
  files themselves are readable with any text tool.
- **Export**: copy the folder. `notes.jsonl` holds every saved note and fix, one JSON object per line
  (the latest line per `id` wins); `obs/` holds the captured records per project and session.
- **Forget one note**: `engram forget <note-id>` removes every line of it from disk.
- **Purge a value**: `engram purge <regex|obs-id>` deletes every observation, note and recap that
  matches, for a secret or a customer name that redaction missed. `engram resanitize` re-applies the
  current redaction rules to everything stored.
- **Delete everything**: remove the folder (`rm -rf ~/.claude/engram-memory`). Uninstalling the plugin
  does not do this for you. Team files you published stay where you published them.
- **Opt out of capture**: `ENGRAM_DISABLE_CAPTURE=1` everywhere, or an empty `.engram-ignore` at a
  project's root for that project only (recall keeps working; the repository's own `.engram/` is then
  ignored too).

## Troubleshooting

**Nothing is recalled, or the hooks never seem to run.** Run `/engram:status` in the project:

- `last capture in this project: never` (or a date long ago) while you have been working there means the
  capture hooks are not running. Check that the plugin is enabled (`/plugin`) and look at `hook errors`.
- `hook errors: … WARNING …` lists the latest failures; the full stacks are in `error.log` in the data
  folder. A hook that fails still exits 0, so Claude Code shows nothing.
- `capture: off` names the reason (`ENGRAM_DISABLE_CAPTURE` or `.engram-ignore`).
- Recall only adds a block when something matches; a prompt shorter than 4 characters or starting with
  `/` is never searched. Notes saved in another project are not recalled here: search them with
  `/engram:recall <words> --all`, or save rules that hold everywhere with `--global`.

**Slash commands fail with `node: command not found`, or hooks exit 127.** The hooks and the
`/engram:*` commands start through `hooks/run-hook.sh`, which looks for Node in `ENGRAM_NODE`, on
`PATH`, in nvm, in Homebrew/system locations and finally bun. On a machine where none of those hold
Node 18+ (the macOS app gives hooks a bare `PATH`), set `ENGRAM_NODE` to the full path of a Node binary
(`which node` in your terminal), for example in your shell profile or Claude Code's `env` setting.

**Team knowledge does not show up.** `/engram:status` prints the team scope with its reason. A project
is out of scope until you run `/engram:scope on` there (or `scope.json` lists it), and an invalid
`scope.json` keeps every project out. A team folder that is offline is used through its last snapshot;
`/engram:status` reports when it cannot be reached.

**Where is the data?** The personal store is `~/.claude/engram-memory/` unless `ENGRAM_HOME` is set;
`/engram:status` prints the folder in use and the project id (`<folder name>-<hash>`) whose records
live under `obs/<project>/`.

## Development

Development uses bun. The shipped artifact is plain Node.js.

```bash
bun install
bun run test        # builds dist/cli.mjs, then runs unit and Node end-to-end tests
NODE_BIN=/path/to/node18 bun test tests/e2e.test.ts
```

`dist/cli.mjs` is committed because plugin installs do not run a build. Rebuild it with `bun run build`
before committing source changes.

CI (`.github/workflows/ci.yml`) runs the tests, `tsc --noEmit` and `prettier --check` on Ubuntu, macOS
and Windows with Node 18 and 22, and fails when `dist/cli.mjs` differs from a fresh build. The bundle
is reproducible byte for byte with bun 1.4.4, the version CI pins; build with the same version.

Installed copies stay on the version in `.claude-plugin/plugin.json` until it changes. Bump it (and
the same field in `package.json` and `marketplace.json`) in every change meant to reach users.

## License

MIT
