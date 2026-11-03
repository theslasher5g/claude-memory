---
description: Build the initial memory for this repo (bounded, non-derivable facts only)
allowed-tools: Bash(node:*), Bash(git log:*), Read, Glob, Grep
---
Bootstrap lean-memory for this repo. CLI: `node "${CLAUDE_PLUGIN_ROOT}/scripts/mem.mjs"`. Run `stats` first; if notes already exist, only add what is missing.

Read, in this order and stop after ~10 reads: CLAUDE.md, README, docs/ or ADRs, CI config (test/build commands and quirks), `git log --oneline -300` (reverts, fixes with a reason, "instead of"/"because"), comments containing HACK/FIXME/WARNING.

Save at most 25 notes with `add`. Only what is NOT derivable from the code: decisions with their reason, gotchas, rejected alternatives, conventions, commands with quirks. One fact per note, title <= 80 and body <= 500 chars.
- `--topic` must be one of: build, test, architecture, security, platform, data, api, ui, workflow, ops.
- Rules that apply to one area get `--paths "dir/**"` so they load only when those files are touched.
- `--pin` only for unscoped notes (pinned notes appear in the index; path-scoped notes load by file instead, a pin has no effect on them).
- Never store secrets, tokens or credentials. Skip anything a reader gets from the code in a minute.

Finish with: the number of notes saved, the list from `list`, and the reminder to commit `.claude/memory/notes.jsonl` (the git-ignored `memory.db` is only a local cache).
