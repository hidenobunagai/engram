---
name: scope
description: Show whether the current project is in engram's team scope, or select/unselect it. Only selected projects receive team knowledge and can share notes; everything else (for example PC setup sessions) stays personal.
argument-hint: "[on|off]"
disable-model-invocation: true
---

Run:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh" scope $ARGUMENTS
```

Report the result in one or two sentences.
