---
name: share
description: Export a saved engram note to the team knowledge repository as a Markdown file for review via pull request. Only notes saved inside the team scope (analysis projects listed in scope.json) can be shared.
argument-hint: "[note-id]"
disable-model-invocation: true
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" share $ARGUMENTS
```

Without an id this lists shareable notes; ask the user which to share, then run it again with that id.
Show the written file to the user and help them review it. Commit and open a PR only if the user asks.
