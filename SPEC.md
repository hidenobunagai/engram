# engram specification

## Goal

Give each analyst a memory that fills itself while they work in Claude Code and comes back when it is
relevant. Sharing with the team is a secondary, opt-in step.

## Constraints

- Runs on the analyst's machine with Node.js 18+ only. No npm install at plugin install time, no
  native or WASM modules, no daemon, and no network calls.
- Hooks must never break a session: any failure exits 0 and is logged to `<data dir>/error.log`.
- Never store tool output or query results.
- Team knowledge applies only inside the team scope, in both directions.

## Components

| Path               | Role                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`       | Entry point for hooks (`hook <event>`) and commands (`recall`, `save`, `forget`, `share`, `scope`, `history`, `status`) |
| `src/hooks.ts`     | Capture, error → fix pairing, prompt-time recall, session-start recap and team index                                    |
| `src/memory.ts`    | JSONL storage, project ids, retention                                                                                   |
| `src/search.ts`    | Tokenizer and BM25 ranking                                                                                              |
| `src/team.ts`      | Team Markdown store: discovery, scope, frontmatter parsing, safe writes                                                 |
| `src/sanitizer.ts` | Secret and email redaction applied to everything written                                                                |
| `skills/*`         | `/engram:recall`, `/engram:save`, `/engram:share`, `/engram:scope`, `/engram:history`, `/engram:status`                 |
| `dist/cli.mjs`     | Bundled build that hooks and skills run (committed)                                                                     |

## Hooks

| Event                | Mode  | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`       | sync  | Prune old observations; print the previous session's recap, the project's 5 latest notes, the team index (about 6 KB at most, in scope only) and a note count split into this project's notes and how many belong to other projects                                                                                                                                                                                                                                                                                                                                        |
| `UserPromptSubmit`   | sync  | Search memory with the prompt and print up to 5 matches within 1.5 KB; record the prompt and update the recap                                                                                                                                                                                                                                                                                                                                                                                        |
| `PostToolUse`        | async | For `Bash`, file-writing tools and `mcp__*` tools, record the command (Bash); `<tool> <path>` plus the written text for code files (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`; notebooks keep cell source only, and delimited-data text or a `.sql` file without SQL keeps the path only); or the `sql`/`query`/`statement`/`command` string fields of the input (MCP; calls without one are skipped). Commands whose every chained segment is trivial (`ls`, `cat`, `git status`, …) are skipped |
| `PostToolUseFailure` | async | Same, plus the error text (head and tail kept, 1,000 characters at most)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SessionStart` (2nd) | async | Refresh the team snapshot (TTL 10 minutes) and persist the `team_dir` option                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Stop`               | async | Store Claude's last reply in the recap; refresh the team snapshot                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Plain stdout is used for injection because it works for both `SessionStart` and `UserPromptSubmit`.
Injected text is phrased as factual statements.

## Storage

Root: `ENGRAM_HOME` or `~/.claude/engram-memory/`.

- `obs/<project>/<session>.jsonl`: `{t:"obs", id, ts, session, project, tool, input, error?}`. One file
  per session, appended one line per record, so concurrent hooks never rewrite each other's data.
  Deleted after `ENGRAM_RETENTION_DAYS` (default 90) without changes.
- `notes.jsonl`: `{t:"note", id, ts, project, kind, title, body, tables?, tags?, root?}`. The latest
  record per id wins. `root` is the project root at save time. Saving the same project, kind, title and body reuses the id. `forget` rewrites the file without the note.
- `recaps/<project>.json`: the latest session's first and last prompt and last reply.

`project` = basename of the git root plus the first 8 hex characters of the SHA-1 of its path.

## Error → fix pairing

File-writing tools are never paired. When a tool call succeeds, engram scans the last 15 records of the same session, newest first, for a
record from the same tool that is similar to it. Similar means the same tool, with trivial leading
segments (such as `cd X &&`) stripped for Bash, and a token Jaccard similarity of at least 0.3.

- If the first similar record is a failure, engram saves a `fix` note. The note holds the failed input,
  the error and the working input. Its title comes from the error's headline line: the last line of a
  traceback, otherwise the first line.
- If the first similar record is a success, engram stops. A failure that an earlier success in the
  window already resolved is not paired again, so one error is paired at most once.

## Search

- Tokens: lowercase ASCII identifiers kept whole (`analytics.dim_users`), plus their `.` parts and
  their `_` parts longer than 2 characters, minus warehouse prefixes (`dim`, `fct`, `stg`, `mart`, …).
  CJK runs become character bigrams, except bigrams containing hiragana. SQL keywords and common
  English words are dropped.
- Ranking: BM25 (k1 1.2, b 0.75) times a source weight:
  - team items: 1.5
  - notes from this project: 1.3; notes from other projects: 1.1
  - failed calls: 1.0
  - successful calls: 0.6
  - prompts: 0.5
- Prompt-time recall needs the matched terms' IDF to reach `min(3, half the IDF of the query terms
present in the corpus)`. It leaves out the current session and past prompts, and collapses identical
  lines; all edits of one file collapse to one line. A shared note is indexed once, through its team copy. Fix notes show the working command.
- Notes are searched across all projects, because analysts query the same warehouse from many folders.
  Observations are searched only within their own project.

## Team store

- Folders: the project's nearest `.engram/` (up to the git root) and the shared folder, in that
  priority. The shared folder is `ENGRAM_TEAM_DIR`, else, inside plugin hooks
  (`CLAUDE_PLUGIN_ROOT` set), the plugin option `team_dir` (`CLAUDE_PLUGIN_OPTION_TEAM_DIR`; empty means
  none), else `config.json`'s `teamDir`, else `~/.claude/engram-team` if it exists. Hooks persist the
  option to `config.json` (and remove it when cleared) so CLI commands run through the Bash tool, which
  lacks the variable, see the same folder. `config.json` is updated under a lock file.
- Snapshot: `<data dir>/team-snapshot.json` holds the shared folder's `scope.json` and parsed items.
  Sync hooks (`SessionStart`, `UserPromptSubmit`) read only the snapshot and the local `.engram/`, so a
  slow or offline network drive never delays a prompt. Async `SessionStart` and `Stop` refresh it when
  older than 10 minutes, guarded by a lock file (2 minutes) and written with tmp + rename. `status`,
  `scope` and `share` refresh it unconditionally and report an unreachable folder. Because sync hooks
  trust the snapshot, a `scope.json` change reaches prompts after the next refresh (up to 10 minutes,
  or longer while the folder is offline).
- Scope, checked in this order:
  1. the project has a `.engram/` folder: in scope;
  2. no shared folder is configured: in scope (there is nothing to share with);
  3. the user selected the project for the current shared folder (`scope on` stores
     `{root, remote, team}` in `config.json`; a clone with the same remote also counts; switching
     folders does not carry selections over): in scope;
  4. the snapshot's `scope.json` lists the normalized origin remote (`projects`) or the project root
     (`paths`; `*` globs, `~` expanded): in scope;
  5. otherwise: out of scope.

  An invalid `scope.json` shape is reported and counts as no match. Out of scope, `loadTeam` returns
  nothing (no injection, no team recall), and `share` refuses notes whose `root` is out of scope. The
  scope is re-checked at share time, so a note without `root`, or from a project that is not selected,
  is not shareable.

- Folders inside a store: `caveats metrics queries decisions facts fixes notes`.
- Frontmatter: `id`, `title` (both required), plus `kind`, `summary`, `target_tables`, `tags`, `author`,
  `status`, `created_at`. Lists may be inline, block or a single scalar. Files with `status: deprecated`
  are hidden.
- `share` without an id lists in-scope notes not yet in the team store. `share <id>` prints a preview.
  `share <id> --yes` writes JSON-quoted frontmatter to the shared folder (else the project `.engram/`,
  which only accepts that project's own notes, or `--to DIR`) and refreshes the snapshot. It reuses the
  file that already holds the id, refuses to replace one whose content differs unless `--update` is
  given, and never overwrites another item (new files get a suffix on name clashes).

## History

`history` lists session files (start, end, record and error counts, first prompt), newest first, for
this project or `--all`. `history <session-id prefix | YYYY-MM-DD>` prints that session's or that local
day's records in order (last 200).

## Known limits

- Search reads every record of the project on each prompt. With 20,000 observations it takes about
  0.25 s on a Raspberry Pi 5. Add a cached index if that grows.
- Redaction is regex based. Unusual secret formats and personal data in SQL literals can pass through.
- Fix pairing does not pair commands simply because they share a command name, but unrelated calls that share many tokens (such as `uv run python a.py` and `uv run python b.py`) can still pair.
