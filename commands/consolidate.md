---
description: Merge the many small notes of one topic into fewer atomic notes (nothing is lost silently)
argument-hint: <topic>
allowed-tools: Bash(node:*)
---
Consolidate lean-memory topic `$ARGUMENTS`. CLI: `node "${CLAUDE_PLUGIN_ROOT}/scripts/mem.mjs"`.

1. `list --topic $ARGUMENTS --full` to read every note of the topic (if no topic was given, run `doctor` and pick the topic it flags with CONSOLIDATE).
2. Group notes that describe the same area, rule or decision. Leave unrelated notes alone.
3. For each group of 2+ notes write ONE merged note (title <= 80, body <= 500 characters) that keeps every distinct fact, number, command and the reason behind decisions; drop only true repetition. If the facts do not fit into 500 characters, do not merge that group.
4. Run `merge <id> <id...> --title "…" --body "…"` (tags, paths, pin and topic are carried over; pass `--paths` only to change them).
5. Finish with `doctor` and report: notes before/after, which groups were merged, anything you refused to merge and why.
