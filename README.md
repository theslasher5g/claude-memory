# lean-memory – token-efficient memory for Claude Code

Goal: Claude remembers decisions, gotchas and preferences **without** loading a large memory block every session – even in very large projects.

**Requirement:** Node ≥ 22.5 (uses the built-in `node:sqlite`, no npm packages).

## Architecture: progressive disclosure

| Tier | When | What | Cost |
|---|---|---|---|
| 1. Index | SessionStart (also after `/clear`, `/compact`) | Small stores: titles. Large stores: pinned titles + **topic overview** `billing(23) auth(14)…` + top titles. Hard budget (500 tokens) | constant, independent of the number of notes |
| 2. Path notes | PreToolUse on Read/Edit/Write | Notes with `--paths` load only when a matching file is touched; once per session | 0 tokens elsewhere |
| 3. Auto-recall | UserPromptSubmit | max. 3 notes, only on a strong BM25 match, never twice, 250-token cap | 0 on a weak match |
| 4. Lookup | on demand | `search [--topic t]` → snippets, `get <id>` → full text | only what is needed |

## Performance with large stores
- **SQLite (WAL) + FTS5/BM25** instead of JSONL: search, dedupe candidates and counters are index-based. Measured with 20,000 notes: SessionStart hook ≈ 120 ms, prompt/path hooks ≈ 80–100 ms (mostly Node startup), index stays at ≈ 490 tokens.
- **Hit counters are small in-place updates** (only `get` counts, merely being shown does not) – no file rewrites, no lost updates with parallel sessions (transactions, `busy_timeout`).
- **Hooks are read-only and create nothing** if no database exists yet.
- **Stable index:** recency is bucketed per week and ties are sorted deterministically, so the index is identical from session to session (prompt-cache friendly).
- An old `memories.jsonl` is imported automatically on first access.

## More savings
- Atomic notes with hard limits (title ≤ 80, body ≤ 500 characters).
- Dedupe/supersede: similar notes are merged, `--supersede <id>` replaces a specific one.
- `prune` removes old, unused, unpinned notes.
- Terse CLI output, German + English stop words.

## Storage & Git
- **Project:** `.claude/memory/notes.jsonl` is the **source of truth and is committed** (one note per line, sorted by id → merge-friendly, no local counters). `memory.db` next to it is only a local cache; the plugin creates a `.gitignore` for it. The cache rebuilds itself after clone, pull or branch switch.
- **Important for cloud sessions and teams:** cloud sessions start from a fresh clone. Only what is on the branch the session starts from is remembered – so merge `notes.jsonl` into `main`.
- **Global (`--global`):** `~/.claude/memory/memory.db`, not in Git (personal preferences).
- Overridable: `LEAN_MEMORY_DIR`, `LEAN_MEMORY_GLOBAL_DIR`.
- Upgrade path: a database from an older version without `notes.jsonl` is exported once on first access; `stats` warns if `memory.db` is still tracked by Git.

## Automatic start in new repos
If a Git repo has no notes yet, the SessionStart hook adds a short hint once (~70 tokens). Claude finishes the first request and then runs `/lean-memory:bootstrap`: bounded (~10 reads, max. 25 notes), only non-derivable facts, a fixed topic list, path binding for folder-specific rules. Afterwards the hint disappears. Disable with `LEAN_MEMORY_AUTOBOOTSTRAP=0`. The bootstrap costs tokens once for the exploration.

## Measurement: does it really save tokens?

Measured on a real repo (aurora-ssh, Rust, 30 notes, 24 of them path-scoped) with headless `claude -p`, 3 runs per question and variant (18 runs), same read-only tools, same model. **Without plugin** means: repo state before the notes, no `lean-memory` loaded. **With plugin:** version 0.3.0, notes as `notes.jsonl`.

| Question | Do the notes fit? | Cost without → with | Time | Tool calls |
|---|---|---|---|---|
| Publish a new release | yes, directly | $0.207 → $0.085 (**−59 %**) | 24 s → 16 s | 4 → 1.3 |
| Extend RDP drive sharing, build and test | partly | $0.254 → $0.206 (**−19 %**) | 44 s → 32 s | 7.3 → 5.7 |
| Find main file and Rust edition | no | $0.078 → $0.076 (**−2 %**) | 11 s → 11 s | 2 → 1.7 |
| **All** | | $0.180 → $0.122 (**−32 %**) | −26 % | 4.4 → 2.9 |

- **Where it saves:** on questions that have matching notes. Claude then knows the right places and reads selectively instead of searching the repo. On questions unrelated to the notes, the plugin's overhead (index ≈ 230 tokens per session start) is not measurable within the noise.
- **Quality:** about the same. A check against 8 repo-verified facts per question gave an average of 5.0 (with) vs. 5.3 (without) for the release question and 5.7 vs. 6.0 for the RDP question. The plugin does not make answers better, only the way to them cheaper. Even with the plugin, the release answer missed the signing order that is in the notes.
- **Cost** is the most meaningful figure because cache reads are billed at a lower rate. Raw context use averaged 192,000 → 129,000 tokens (−33 %), but includes the ≈ 41,000-token base load on every turn.

**Limits:** only 3 runs per cell with large variance (RDP without plugin: 199,000 to 368,000 tokens) – the direction is clear, the exact percentages are not. Two of the three questions were chosen to fit the notes; in daily use questions without a match dominate, so expect roughly 0 to 59 % per question rather than a flat 32 %. The fact check uses text patterns, not a real grading. One repo, one model, headless only, no interactive session.

**Setup, to keep the comparison fair:** both variants run with their own empty config and plugin/skill sync switched off (`CLAUDE_CODE_SYNC_PLUGINS=0`). The repo state without notes contains no trace of them, not even in the Git history. Two earlier measurement series were invalid (plugin loaded via account sync, notes found via `git show HEAD`) and were discarded. Anyone re-measuring must rule out both and check in each run which plugins were loaded.

## Installation
```
/plugin marketplace add theslasher5g/claude-memory
/plugin install lean-memory@claude-memory
```

## Usage
- `/lean-memory:bootstrap` (initial fill) · `/lean-memory:remember <text>` · `/lean-memory:recall <query>` · `/lean-memory:forget <id>`
- CLI (Claude uses it itself, see `skills/memory/SKILL.md`):
  `node scripts/mem.mjs add|search|get|list|topics|forget|pin|unpin|index|stats|prune`
- Path-scoping example: `add --title "Round half-even" --body "…" --paths "src/billing/**" --topic billing`
- `stats` shows the plugin version and the session-start cost in tokens.

## Settings (env)
`LEAN_MEMORY_INDEX_TOKENS` (500) · `LEAN_MEMORY_MAX_HITS` (3) · `LEAN_MEMORY_PROMPT_TOKENS` (250) · `LEAN_MEMORY_PATH_NOTES` (5) · `LEAN_MEMORY_PATH_TOKENS` (400) · `LEAN_MEMORY_AUTOBOOTSTRAP` (`0` disables the bootstrap hint)

## Tests
`node --test`
