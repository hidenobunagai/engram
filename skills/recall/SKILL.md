---
name: recall
description: Search engram memory (past sessions, saved data caveats, metric definitions, error fixes) and team knowledge. Use before writing SQL against unfamiliar tables, when the user refers to earlier work ("前回", "last time"), or when an error looks familiar.
argument-hint: "<words>"
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" recall "$ARGUMENTS"
```

Summarize the relevant results for the user. Team items list a file path; read that file when the details matter.
Records can be outdated, so say when a result conflicts with what you observe now.
