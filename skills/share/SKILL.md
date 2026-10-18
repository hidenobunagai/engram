---
name: share
description: Publish a saved engram note to the team folder (a shared drive or git-backed folder). Only notes from projects in the team scope can be shared.
argument-hint: "[note-id]"
disable-model-invocation: true
---

1. Without an id, list shareable notes and ask the user which one to share:
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" share`
2. With an id, show the preview (nothing is written yet):
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" share <note-id>`
   Show the user the preview and point out anything that should not be shared (customer data, personal paths, credentials).
3. Only after the user confirms, publish it:
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" share <note-id> --yes`

User input: $ARGUMENTS
