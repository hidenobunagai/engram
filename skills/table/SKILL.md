---
name: table
description: Show everything engram knows about one database table in this project — saved caveats and team notes on it, the errors queries on it hit most, the fixes that resolved them, and when it was last queried. Use before writing SQL against a table, or when the user asks what is known about a table ("このテーブルの注意点", "what do we know about dim_users").
argument-hint: "<table name>"
---

Run:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh" table "$ARGUMENTS"
```

Summarize the card for the user: caveats first, then recurring errors and their fixes. Team items list a file path; read that file when the details matter.
Records can be outdated, so say when one conflicts with what you observe now.
