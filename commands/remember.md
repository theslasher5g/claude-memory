---
description: Save a durable note to lean-memory (atomic, ≤500 chars)
argument-hint: <what to remember>
allowed-tools: Bash(node:*)
---
Condense this into ONE atomic note and save it with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/mem.mjs" add --type <decision|fact|pref|gotcha|todo> --title "<=80ch" --body "<=500ch" --tags <a,b>` (add `--global` if it is a user-wide preference). Reply only with the CLI result.

Note: $ARGUMENTS
