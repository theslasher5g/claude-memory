---
description: Search lean-memory and show matching notes
argument-hint: <query>
allowed-tools: Bash(node:*)
---
Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/mem.mjs" search $ARGUMENTS` and report the result briefly. Use `get <id>` only for notes whose full body is needed.
