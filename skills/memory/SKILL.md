---
name: memory
description: Save and recall durable project notes (decisions, gotchas, preferences) with minimal tokens. Use when the user says "remember", "merk dir", asks what was decided before, or you learn a non-obvious fact worth keeping across sessions.
---

# lean-memory

CLI: `node "${CLAUDE_PLUGIN_ROOT}/scripts/mem.mjs" <cmd>`

The session-start index lists note titles only. Never load everything: **search, then get**.

## Recall
- `topics` → topic overview with counts; `search <query> --topic t` narrows large stores.
- `search <query>` → top 5 as `id [type] title — snippet` (cheap). Add `--full` only if needed.
- `get <id...>` → full body of the notes you actually need.

## Save (atomic, short)
`add --type decision|fact|pref|gotcha|todo --title "<=80 chars" --body "<=500 chars" [--tags a,b] [--topic t] [--paths "src/x/**,docs/y.md"] [--global] [--pin]`

Rules:
1. One fact per note. Title = the claim, body = the why / how to apply.
2. Save only what is durable, non-obvious and **not derivable from code, git log or docs**.
3. Similar notes are merged automatically; to replace a specific one use `--supersede <id>`.
4. Note applies to one area of the repo? Add `--paths` (globs, comma-separated, no braces). Such notes are hidden from the index (unless pinned) and load automatically (once per session) when a matching file is read/edited or a matching path appears in a Bash/Grep/Glob call — prefer this over a global note for anything area-specific.
5. Set `--topic` (default: first tag) so the topic overview stays meaningful.
6. User-wide preferences → `--global`; project knowledge → default (project).
7. Never store secrets, tokens or credentials.

## Maintain
- `forget <id...>` remove outdated notes — do this as soon as you notice a note is wrong.
- `pin <id>` keep a note always visible in the index (also path-scoped ones: the title shows in the index, the body still loads by path). Use it sparingly for the few rules that must never be missed.
- `doctor` – read-only health check: path globs that match no file, notes that mention files that no longer exist, near-duplicates, old never-fetched notes, topics with too many notes.
- `merge <id> <id...> --title "…" --body "…"` – replace several notes by one (tags, paths, pin and topic carried over). For whole topics use `/lean-memory:consolidate <topic>`.
- `prune [--days 90] [--apply]` drop unused, old, unpinned notes. `stats` shows the session-start token cost.

## Persistence & git
Project notes live in `.claude/memory/notes.jsonl` (tracked in git); `memory.db` next to it is a git-ignored cache that rebuilds itself after clone/pull/branch switch. After saving notes, remind the user to **commit `notes.jsonl`** — only what is on the branch a session starts from is remembered in cloud sessions.
No notes yet in a git repo? Run the `lean-memory:bootstrap` skill once.
