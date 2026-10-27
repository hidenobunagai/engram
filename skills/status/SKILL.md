---
name: status
description: Show what engram has stored (saved notes, captured observations) and which team knowledge files are loaded or skipped.
disable-model-invocation: true
---

Run `sh "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh" status` and report the result. Explain any skipped team files, and call out a hook-error warning or a last capture long ago: both mean the hooks are failing.
If the user asks how much is stored or which tables come up most, run `sh "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh" stats` too.
