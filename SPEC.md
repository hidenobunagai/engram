# engram specification

## Goal

Give each analyst a memory that fills itself while they work in Claude Code and comes back when it is
relevant. Sharing with the team is a secondary, opt-in step.

## Constraints

- Runs on the analyst's machine with Node.js 18+ only. No npm install at plugin install time, no
  native or WASM modules, no daemon, and no network calls.
- Hooks must never break a session: any failure exits 0 and is logged to `<data dir>/error.log`
  (one entry per failure: an ISO timestamp, then the stack). Past 256 KB the log is cut to its newest
  half at an entry boundary. `status` reports the entry count, the last one's time, and, when any is
  younger than 7 days, a warning with the latest 3.
- Never store tool output or query results. (A failed call's error text and the first sentence of
  the last reply are stored, redacted; see What is never stored.)
- Team knowledge applies only inside the team scope, in both directions.

## Components

| Path               | Role                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`       | Entry point for hooks (`hook <event>`) and commands (`recall`, `save`, `forget`, `purge`, `resanitize`, `share`, `scope`, `history`, `status`, `table`, `stats`) |
| `src/hooks.ts`     | Capture, error → fix pairing, prompt-time recall, session-start recap and team index                                                                             |
| `src/memory.ts`    | JSONL storage, project ids, retention                                                                                                                            |
| `src/search.ts`    | Tokenizer and BM25 ranking                                                                                                                                       |
| `src/postings.ts`  | Persistent postings index over each project's observations, so recall does not re-read every session log                                                         |
| `src/team.ts`      | Team Markdown store: discovery, scope, frontmatter parsing, safe writes                                                                                          |
| `src/sanitizer.ts` | Secret and email redaction applied to everything written                                                                                                         |
| `skills/*`         | `/engram:recall`, `/engram:save`, `/engram:share`, `/engram:scope`, `/engram:history`, `/engram:status`, `/engram:table`                                         |
| `dist/cli.mjs`     | Bundled build that hooks and skills run (committed); both start it through `hooks/run-hook.sh`, which resolves a Node interpreter                                |

## Hooks

| Event                | Mode  | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`       | sync  | Prune old observations and recaps, compact `notes.jsonl`; print the previous session's recap, the project's 5 latest notes, the team index (6,000 UTF-8 bytes at most for the whole output, in scope only) and a note count split into this project's notes and how many belong to other projects                                                                                                                                                                                                                                                     |
| `UserPromptSubmit`   | sync  | Search memory with the prompt and print up to 5 matches within 1,500 UTF-8 bytes, leaving out anything already shown in this session; record the prompt and update the recap                                                                                                                                                                                                                                                                                                                                                                          |
| `PreToolUse`         | sync  | For `Bash` and `mcp__*` calls that carry SQL, return the caveats and fixes on the tables the query names (up to 3, within 1,200 UTF-8 bytes) as `additionalContext`. A fix whose error blamed a column the query uses again comes first. Reads only `notes.jsonl`, `hits.jsonl`, the team snapshot and the session ledger, never observations; a call without SQL returns before reading anything                                                                                                                                                     |
| `PostToolUse`        | async | For `Bash`, file-writing tools and `mcp__*` tools, record the command (Bash); `<tool> <path>` plus the written text for code files (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`; notebooks keep cell source only, and delimited-data text or a `.sql` file without SQL keeps the path only); or the `sql`/`statement` string fields of the input, plus a `query`/`command` field only when its value looks like SQL (MCP; calls without one are skipped). Commands whose every chained segment is trivial (`ls`, `cat`, `git status`, …) are skipped |
| `PostToolUseFailure` | async | Same, plus the error text (head and tail kept, 1,000 characters at most)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SessionStart` (2nd) | async | Refresh the team snapshot (TTL 10 minutes), persist the `team_dir` option, and rebuild a stale postings index                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Stop`               | async | Store the first sentence of Claude's last reply in the recap; refresh the team snapshot; rebuild a stale postings index                                                                                                                                                                                                                                                                                                                                                                                                                               |

Plain stdout is used for injection because it works for both `SessionStart` and `UserPromptSubmit`.
`PreToolUse` prints `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": …}}`
and never a permission decision, so it cannot block or change the call; any error exits 0 with no output.

`SessionStart` with `source: "compact"` also prints the current session's own fix notes (up to 5) and
its last 3 errors that no fix explains, since the compaction removed them from the context and
prompt-time recall leaves the current session out. It empties the session's ledger for the same reason.
Injected text is phrased as factual statements.

## Storage

Root: `ENGRAM_HOME` or `~/.claude/engram-memory/`.

- `obs/<project>/<session>.jsonl`: `{t:"obs", id, ts, session, project, tool, input, error?}`. One file
  per session, appended one line per record, so concurrent hooks never rewrite each other's data.
  Deleted after `ENGRAM_RETENTION_DAYS` (default 90) without changes.
- `obs/<project>/<session>.injected`: the ledger of doc ids (or file groups) already shown in the
  session, one per line. Pruned with the session's log.
- `notes.jsonl`: `{t:"note", id, ts, project, kind, title, body, tables?, tags?, sources?, root?, source?, created?, global?}`.
  `source` is `auto` for a paired fix and `user` for `save` (older records: a `fix` with a `session` is
  `auto`, anything else `user`); `created` is the first save, `ts` the latest; `global` makes it
  recalled in every project.
  `sources` lists the observations a fix was derived from (the failed and the working run). The latest
  record per id wins. `root` is the project root at save time. Saving the same project, kind, title and body reuses the id. `forget` rewrites the file with the latest line of each remaining note. `SessionStart` does the same once superseded lines outnumber live notes, and `purge`/`resanitize` whenever one exists (an old version may still hold the purged text).
- `recaps/<project>/<session>.json`: one per session, so parallel sessions in a project keep both: the
  first and last prompt and the first sentence of the last reply. Only the first sentence is kept,
  because a reply usually states query results. Written through a temp file and a rename. Session start
  shows the newest recap of another session. Recaps older than the retention period are pruned, except
  the newest of each project. A legacy `recaps/<project>.json` is still read.
- `hits.jsonl`: one line per note injection `{id, ts}` (prompt and `PreToolUse`), plus `{id, ts,
reset: true}` when an automatic fix's error is paired again (any auto fix of the same project and
  title). Compacted at `SessionStart` to `{id, ts, n}` per note once it holds 4× more lines than notes
  (and more than 200), dropping deleted notes.
- `error.log`: hook failures (see Constraints).
- `index/<project>/base.idx` and `delta.jsonl`: the postings index (see Search). Derived from the
  observation logs, so deleting it loses nothing.

`project` = basename of the project root plus the first 8 hex characters of the SHA-1 of its path
(`pathKey`: forward slashes, lowercased on Windows). The root, walking up from cwd and stopping
before `$HOME`:

1. the nearest folder with `.git` (file or directory) or a `.jj` directory;
2. otherwise the nearest folder with a `.engram/` directory, `dbt_project.yml` or `pyproject.toml`;
3. otherwise cwd.

So a git repository nested in a marked folder is its own project, a marker inside a repository does
not split it, and every git repository keeps the id it had before folder markers existed. `$HOME`
and the folders above it are never a root, whatever they hold.

## Note lifecycle

Only automatic fixes (`source: auto`) decay; saved notes and team items never do. The state is
computed when read (prompt, `PreToolUse`, `SessionStart`, `status`) from stored timestamps:

- `confirmed` = the later of the note's `ts` and its last `reset` in `hits.jsonl`;
- **demoted, `idle`**: no injection and no confirmation for 90 days;
- **demoted, `unconfirmed`**: injected 10 or more times since `confirmed`;
- otherwise **active**.

A demoted fix is left out of prompt injection, the `PreToolUse` check and the session-start list, but
`recall` and `history` still find it. Pairing its error again resets the count and makes it active.
`status` prints the counts by source and by state.

## What is never stored

Command output, query results, and file contents, with these rules:

- A written file is recorded by path alone unless its extension is a code extension (`.sql`, `.py`,
  `.r`, `.ipynb`, `.yaml`, `.sh`, `.jinja2`, `.j2`, `.js`, `.ts`). `.md` is not one of them, because a
  report states findings rather than code.
- A captured command or prompt keeps its head line. A run of three or more consecutive rows that
  carry the same number of `,` `;` `|` or tab delimiters is replaced with `[N data rows omitted]`. This
  covers a Bash heredoc body and a table pasted into a prompt. A run whose first three rows look like
  SQL is left alone, so a query is not mistaken for data.
- The recap stores only the first sentence of the last reply.

Capture is skipped entirely when `ENGRAM_DISABLE_CAPTURE=1`, or when the project root holds a
`.engram-ignore` file. The second is per project and does not affect recall of personal memory; it
also makes engram ignore the repository's own `.engram/` team folder.

## Removing stored data

Two commands rewrite the stores through a temp file and rename, so a crash leaves the original intact.
They never touch team files.

- `purge <regex|obs-id>` deletes every observation, note and recap whose text matches, so no redaction
  marker is left behind to record where the value sat. A target starting with `obs-` selects one
  observation by id. It prints the number of affected records per store.
- `resanitize` runs `sanitize` over every stored text field, which also cleans records written before a
  rule existed. Text fields are `input` and `error` for observations, `title` and `body` for notes, and
  `firstPrompt`, `lastPrompt` and `lastReply` for recaps.

## Error → fix pairing

File-writing tools are never paired. When a tool call succeeds, engram scans the last 15 records of the same session, newest first, for a
record from the same tool that is similar to it. Similar means the same tool, with trivial leading
segments (such as `cd X &&`) stripped for Bash, and a token Jaccard similarity of at least 0.3 after
dropping table names and any identifier the error blames, so two queries on one table are not
similar just for sharing it. A pair is skipped when the success still names the blamed identifier,
when the error's headline is only an exit code or a failure count, and when the retried input is
unchanged unless an intervening `Write`/`Edit` names the fix.

- If the first similar record is a failure, engram saves a `fix` note. The note holds the failed input,
  the error and the working input, plus the edited path when an unchanged retry was fixed by an edit.
  Its title comes from the error's headline line: the last line of a traceback, otherwise the first line.
- If the first similar record is a success, engram stops. A failure that an earlier success in the
  window already resolved is not paired again, so one error is paired at most once.

## Search

- Tokens: text is NFKC-normalized first, so full-width ASCII from a Japanese IME (`ｄｉｍ＿ｕｓｅｒｓ`)
  and half-width katakana match their usual forms; the substring prefilter and the table channel use
  the same normalization. Then lowercase ASCII identifiers kept whole (`analytics.dim_users`), plus their `.` parts and
  their `_` parts longer than 2 characters, minus warehouse prefixes (`dim`, `fct`, `stg`, `mart`, …).
  CJK runs become character bigrams, except bigrams containing hiragana. SQL keywords and common
  English words are dropped.
- Ranking: BM25 (k1 1.2, b 0.75) times a source weight:
  - team items: 1.5
  - notes from this project: 1.3; global notes from other projects (and any with `recall --all`): 1.1
  - failed calls: 1.0
  - successful calls: 0.6
  - prompts: 0.5
- Prompt-time recall needs the matched terms' IDF to reach `min(3, half the IDF of the query terms
present in the corpus)`. It leaves out the current session and past prompts, and collapses identical
  lines; all edits of one file collapse to one line. A shared note is indexed once, through its team copy. Fix notes show the working command,
  and the observations a fix was derived from are left out of every search.
- Table channel: a note or team item whose `tables` the prompt names, by the whole name or a trailing
  dotted part (`dim_users` names `analytics.dim_users`; `users` alone does not name `dim_users`), is
  added ahead of the BM25 hits regardless of the IDF floor. At most 3 come from this channel, ordered
  caveat, fix, metric, then the rest; they still count toward the 5-item and 1,500-byte limits. This keeps
  a caveat on a table the corpus mentions everywhere from scoring near zero.
- Table names in SQL (a fix note's `tables`, the `PreToolUse` check) are the names after `FROM`,
  `JOIN`, `INTO`, `UPDATE` and `TABLE`, plus every entry of a comma-separated `FROM` list
  (`FROM a x, b AS y`). Names a `WITH` clause defines, `from x import y` (Python) and `FROM` inside
  `EXTRACT(...)`, `TRIM(...)`, `SUBSTRING(...)`, `POSITION(...)` and `OVERLAY(...)` do not count.
- A doc shown at one prompt is not shown again in the same session (the `.injected` ledger), and a hit
  that collapsed into a shown line counts as shown.
- Notes are searched within their project, plus notes saved with `--global` from any project.
  `recall --all` searches every project's notes. Observations are searched only within their own
  project. Team items follow the team scope, unchanged.

## Postings index

Prompt-time recall (`UserPromptSubmit`) and `recall` read observations through a per-project index
instead of re-reading and re-tokenizing every session log. Notes and team items are not indexed:
they are few, and their visibility and lifecycle are decided when read. The results are identical to
a full scan, hit for hit and in the same order.

- `base.idx` is written whole (temp file + rename) by a rebuild. It holds, per session log, the bytes
  indexed; per observation, its id, session, prompt flag, byte offset and length in its log, token
  count, kind, title, timestamp and weight; per token, the observations holding it with their term
  frequency; and per whitespace-delimited chunk of the normalized search text, the observations
  holding it. The chunks reproduce the full scan's substring prefilter exactly, which decides the
  average document length BM25 uses. Display text is not stored: the hits that are shown are re-read
  from their log at the stored offset.
- `delta.jsonl` gets one appended line per observation captured after the rebuild (capture hooks
  and the prompt record), so the hot path never rebuilds.
- Freshness: the bytes indexed per log (base plus deltas) must equal each log's size, and the set of
  logs must match. A missing, foreign, truncated or torn index, a capture whose delta is not written
  yet, a pruned or rewritten log: each makes that search fall back to the full scan, and the index is
  rebuilt after the hook printed its answer. A rebuild first moves the delta aside, so a capture that
  races it can only be counted twice, which the size check rejects, never lost.
- `purge`/`resanitize` (when they changed an observation) and pruning (when it deleted a file) drop
  every index explicitly, because a rewrite can keep a log's size. Deleted or re-redacted text is
  therefore never served from a stale index.
- The async `SessionStart` refresh and `Stop` hooks rebuild a stale index and fold a delta larger than
  1 MB into a new base.
- Any index error degrades to the full scan; the hook never fails because of it.

## Team files on disk

Team Markdown files are read as UTF-8. A file that is not valid UTF-8 is decoded as Shift_JIS
(CP932, what Notepad on Japanese Windows saves), including NEC and IBM extension characters such as
`①` and `髙`; without an ICU that knows Shift_JIS, it falls back to lossy UTF-8. engram itself always
writes UTF-8.

## Team store

- Folders: the project's nearest `.engram/` (up to the git root) and the shared folder, in that
  priority. The shared folder is `ENGRAM_TEAM_DIR`, else, inside plugin hooks
  (`CLAUDE_PLUGIN_ROOT` set), the plugin option `team_dir` (`CLAUDE_PLUGIN_OPTION_TEAM_DIR`; empty means
  none), else `config.json`'s `teamDir`, else `~/.claude/engram-team` if it exists. Hooks persist the
  option to `config.json` (and remove it when cleared) so CLI commands run through the Bash tool, which
  lacks the variable, see the same folder. `config.json` is updated under a lock file.
- Snapshot: `<data dir>/team-snapshot.json` holds the shared folder's `scope.json` and parsed items.
  Sync hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`) read only the snapshot and the local `.engram/`, so a
  slow or offline network drive never delays a prompt. Async `SessionStart` and `Stop` refresh it when
  older than 10 minutes, guarded by a lock file (created exclusively; one older than 2 minutes counts as
  abandoned) and written with tmp + rename. A cached refresh skips while another process holds a live
  lock. `status`, `scope` and `share` refresh unconditionally (a TTL of 0 or less) and report an
  unreachable folder; they read the folder even when another process holds the lock, and remove only a
  lock they created. Because sync hooks
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

  Rule 1 means a cloned repository that carries a `.engram/` folder joins the scope by itself, and its
  files are injected like team knowledge: the same trust model as a repository's `CLAUDE.md`. A
  `.engram-ignore` at the project root opts the repository out: its `.engram/` is then ignored and rules
  2–5 decide.

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
  given, and never overwrites another item: a new file is created exclusively (`wx`), and when another
  writer created the same name first, the next free suffix is taken. A replacement (`--update`) goes
  through a temp file and a rename.

## History

`history` lists session files (start, end, record and error counts, first prompt), newest first, for
this project or `--all`. `history <session-id prefix | YYYY-MM-DD>` prints that session's or that local
day's records in order (last 200), from this project or, with `--all`, every project.

## Table cards and stats

- `table <name>` reads this project's view: notes of this project plus global ones, team items in
  scope, and this project's observations. A note or team item is on the table when its `tables` name it
  (the same rule as the table channel) or its title or body holds it as a whole identifier. It prints
  `last touched` (the newest observation that queried the table, or note on it) with the count of
  recorded runs and failures; `Caveats and notes` (team items first, then caveats, metrics, decisions,
  facts, queries and notes; 10 at most); `Most common errors` (error headlines of failed runs on the
  table, by count; 5 at most); and `Fixes that resolved errors` (fix notes on the table, newest first;
  5 at most). With nothing known it says so and points at `recall --all`.
- `stats` prints the data dir's size and file count, the share of `obs/`, `notes.jsonl`, `hits.jsonl`,
  `index`, `recaps` and `error.log`; observations in this project (errors, prompts) and across all
  projects; notes by kind and how many are recalled here; notes by source and lifecycle (as `status`);
  team items loaded; and the 10 tables with the most recorded runs in this project (prompts excluded).
- `status` also prints the project root and the shell line that runs these commands from a terminal
  (`sh "<plugin>/hooks/run-hook.sh" <command>`).

## Known limits

- The index still reads its whole base file per prompt, so cost grows with history, but far more
  slowly than the full scan. With 20,000 observations on the development VM, `hook prompt` under
  Node took 739 ms (median of 9) with a full scan and 287 ms with the index; Node's own start is about
  80 ms of that. The first prompt after a large change pays one full scan plus a rebuild.
- Redaction is regex based. Unusual secret formats and personal data in SQL literals can pass through.
- Fix pairing does not pair commands simply because they share a command name, but unrelated calls that share many tokens (such as `uv run python a.py` and `uv run python b.py`) can still pair.
