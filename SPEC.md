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

| Path               | Role                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`       | Entry point for hooks (`hook <event>`) and commands (`recall`, `save`, `forget`, `share`, `history`, `status`) |
| `src/hooks.ts`     | Capture, error → fix pairing, prompt-time recall, session-start recap and team index                           |
| `src/memory.ts`    | JSONL storage, project ids, retention                                                                          |
| `src/search.ts`    | Tokenizer and BM25 ranking                                                                                     |
| `src/team.ts`      | Team Markdown store: discovery, scope, frontmatter parsing, safe writes                                        |
| `src/sanitizer.ts` | Secret and email redaction applied to everything written                                                       |
| `skills/*`         | `/engram:recall`, `/engram:save`, `/engram:share`, `/engram:history`, `/engram:status`                         |
| `dist/cli.mjs`     | Bundled build that hooks and skills run (committed)                                                            |

## Hooks

| Event                | Mode  | Behavior                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`       | sync  | Prune old observations; print the previous session's recap, the project's 5 latest notes, the team index (about 6 KB at most, in scope only) and a note count                                                                                                                                                                                                                             |
| `UserPromptSubmit`   | sync  | Search memory with the prompt and print up to 5 matches within 1.5 KB; record the prompt and update the recap                                                                                                                                                                                                                                                                             |
| `PostToolUse`        | async | For `Bash`, file-writing tools and `mcp__*` tools, record the command (Bash); `<tool> <path>` plus the written text for code files (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`); or the `sql`/`query`/`statement`/`command` string fields of the input (MCP; calls without one are skipped). Commands whose every chained segment is trivial (`ls`, `cat`, `git status`, …) are skipped |
| `PostToolUseFailure` | async | Same, plus the error text (head and tail kept, 1,000 characters at most)                                                                                                                                                                                                                                                                                                                  |
| `Stop`               | async | Store Claude's last reply in the recap                                                                                                                                                                                                                                                                                                                                                    |

Plain stdout is used for injection because it works for both `SessionStart` and `UserPromptSubmit`.
Injected text is phrased as factual statements.

## Storage

Root: `ENGRAM_HOME` or `~/.claude/engram-memory/`.

- `obs/<project>/<session>.jsonl`: `{t:"obs", id, ts, session, project, tool, input, error?}`. One file
  per session, appended one line per record, so concurrent hooks never rewrite each other's data.
  Deleted after `ENGRAM_RETENTION_DAYS` (default 90) without changes.
- `notes.jsonl`: `{t:"note", id, ts, project, kind, title, body, tables?, tags?, team?}`. The latest
  record per id wins. `team` marks a note saved inside the team scope. Saving the same kind, title and
  body reuses the id. `forget` rewrites the file without the note.
- `recaps/<project>.json`: the latest session's first and last prompt and last reply.

`project` = basename of the git root plus the first 8 hex characters of the SHA-1 of its path.

## Error → fix pairing

File-writing tools are never paired. When a tool call succeeds, engram scans the last 15 records of the same session, newest first, for a
record from the same tool that is similar to it. Similar means the same Bash command name, or a token
Jaccard similarity of at least 0.3.

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
  lines. A shared note is indexed once, through its team copy. Fix notes show the working command.
- Notes are searched across all projects, because analysts query the same warehouse from many folders.
  Observations are searched only within their own project.

## Team store

- Discovery: `ENGRAM_TEAM_DIR` alone, or else the nearest `.engram/` up to the git root plus
  `~/.claude/engram-team/`. A higher-priority store overrides items with the same `id`.
- Folders: `caveats metrics queries decisions facts fixes notes`.
- Frontmatter: `id`, `title` (both required), plus `kind`, `summary`, `target_tables`, `tags`, `author`,
  `status`, `created_at`. Lists may be inline, block or a single scalar. Files with `status: deprecated`
  are hidden.
- Scope: in scope when the project has a `.engram/` folder, when `<shared store>/scope.json` is absent,
  or when its `projects` globs match the normalized origin remote (read from `.git/config`, worktrees
  via `commondir`) or its `paths` globs match the project root. Out of scope, `loadTeam` returns
  nothing (no injection, no team recall) and notes are saved without `team`, so `share` refuses them.
- `share` without an id lists `team` notes not yet in the team store. `share <id>` writes a JSON-quoted frontmatter that round-trips safely. If a different item already uses
  the same file name, `share` adds a suffix instead of overwriting it. Committing is left to the user.

## History

`history` lists session files (start, end, record and error counts, first prompt), newest first, for
this project or `--all`. `history <session-id prefix | YYYY-MM-DD>` prints that session's or that local
day's records in order (last 200).

## Known limits

- Search reads every record of the project on each prompt. With 20,000 observations it takes about
  0.25 s on a Raspberry Pi 5. Add a cached index if that grows.
- Redaction is regex based. Unusual secret formats and personal data in SQL literals can pass through.
- Fix pairing is heuristic and can pair unrelated calls that share a command name.
