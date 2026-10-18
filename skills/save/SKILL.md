---
name: save
description: Save a durable finding to engram memory — a data caveat (table quirk, NULL behavior, outage window), an agreed metric definition, a working query, an analytical decision, or a fix. Use when the user confirms such a finding or asks to remember something.
argument-hint: "<what to remember>"
---

Pick a kind: `caveat`, `metric`, `query`, `decision`, `fact`, `fix`, or `note`.
Write a short title and a self-contained body (include the SQL or the rule, and why).
List the tables involved. Then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" save --kind <kind> --title "<title>" --tables "<t1,t2>" --tags "<tag1,tag2>" <<'ENGRAM_BODY'
<body>
ENGRAM_BODY
```

Secrets and email addresses are redacted automatically, but do not put credentials or customer data in the body.
Tell the user the saved id. They can share it with the team later with `/engram:share <id>`.

User input: $ARGUMENTS
