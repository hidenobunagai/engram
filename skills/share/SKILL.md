---
name: share
description: Export a saved engram note to the team knowledge repository as a Markdown file for review via pull request.
argument-hint: "<note-id>"
disable-model-invocation: true
---

If no id was given, find it first with `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" recall <words>`. Then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" share $ARGUMENTS
```

Show the written file to the user and help them review it. Commit and open a PR only if the user asks.
