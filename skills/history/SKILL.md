---
name: history
description: List past Claude Code sessions recorded by engram, or show the timeline of one session or one day (commands, SQL, file edits, errors). Use when the user asks what they did earlier, on a date, or in a previous session ("この前", "昨日", "last week").
argument-hint: "[session-id | YYYY-MM-DD | --all]"
---

Run:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh" history $ARGUMENTS
```

With no argument it lists this project's sessions; `--all` lists every project. Pass a session id prefix or a date to see that timeline.
Summarize what happened for the user rather than pasting the raw list.
