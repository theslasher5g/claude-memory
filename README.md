# lean-memory – token-effizientes Gedächtnis für Claude Code

Ziel: Claude erinnert sich an Entscheidungen, Stolperfallen und Präferenzen, **ohne** dass pro Session ein großer Memory-Block geladen wird – auch bei sehr großen Projekten.

**Voraussetzung:** Node ≥ 22.5 (nutzt das eingebaute `node:sqlite`, keine npm-Pakete).

## Architektur: progressive Offenlegung

| Stufe | Wann | Was | Kosten |
|---|---|---|---|
| 1. Index | SessionStart (auch nach `/clear`, `/compact`) | Klein: Titel. Groß: angepinnte Titel + **Themenübersicht** `billing(23) auth(14)…` + Top-Titel. Hartes Budget (500 Tokens) | konstant, unabhängig von der Notizanzahl |
| 2. Pfad-Notizen | PreToolUse auf Read/Edit/Write | Notizen mit `--paths` laden nur, wenn eine passende Datei angefasst wird; einmal pro Session | 0 Tokens in anderen Bereichen |
| 3. Auto-Recall | UserPromptSubmit | max. 3 Notizen, nur bei starkem BM25-Treffer, nie doppelt, Cap 250 Tokens | 0 bei schwachem Treffer |
| 4. Abruf | on demand | `search [--topic t]` → Snippets, `get <id>` → Volltext | nur was gebraucht wird |

## Performance bei großen Beständen
- **SQLite (WAL) + FTS5/BM25** statt JSONL: Suche, Dedupe-Kandidaten und Zähler laufen indexbasiert. Gemessen mit 20.000 Notizen: Sessionstart-Hook ≈ 120 ms, Prompt-/Pfad-Hook ≈ 80–100 ms (der Großteil ist Node-Start), Index bleibt bei ≈ 490 Tokens.
- **Trefferzähler sind kleine In-place-Updates** (nur `get` zählt, nicht bloßes Anzeigen) – kein Neuschreiben der Datei, keine verlorenen Updates bei parallelen Sessions (Transaktionen, `busy_timeout`).
- **Hooks sind read-only und legen nichts an**, wenn noch keine Datenbank existiert.
- **Stabiler Index:** Recency wird wochenweise gebucketet und Ties deterministisch sortiert, damit der Index von Session zu Session identisch bleibt (Prompt-Cache-freundlich).
- Alte `memories.jsonl` werden beim ersten Zugriff automatisch importiert.

## Weitere Sparhebel
- Atomare Notizen mit Hard-Limits (Titel ≤ 80, Body ≤ 500 Zeichen).
- Dedupe/Supersede: ähnliche Notizen werden zusammengeführt, `--supersede <id>` ersetzt gezielt.
- `prune` entfernt alte, ungenutzte, nicht angepinnte Notizen.
- Terse CLI-Ausgabe, deutsche + englische Stoppwörter.

## Speicherort
- Projekt: `<projekt>/.claude/memory/memory.db` (in `.gitignore` aufnehmen oder bewusst teilen)
- Global (`--global`): `~/.claude/memory/memory.db`
- Überschreibbar: `LEAN_MEMORY_DIR`, `LEAN_MEMORY_GLOBAL_DIR`

## Installation
```
/plugin marketplace add theslasher5g/claude-memory
/plugin install lean-memory@claude-memory
```

## Nutzung
- `/lean-memory:remember <text>` · `/lean-memory:recall <query>` · `/lean-memory:forget <id>`
- CLI (nutzt Claude selbst, siehe `skills/memory/SKILL.md`):
  `node scripts/mem.mjs add|search|get|list|topics|forget|pin|unpin|index|stats|prune`
- Beispiel Pfad-Scoping: `add --title "Rundung half-even" --body "…" --paths "src/billing/**" --topic billing`
- `stats` zeigt Session-Start-Kosten in Tokens.

## Einstellungen (Env)
`LEAN_MEMORY_INDEX_TOKENS` (500) · `LEAN_MEMORY_MAX_HITS` (3) · `LEAN_MEMORY_PROMPT_TOKENS` (250) · `LEAN_MEMORY_PATH_NOTES` (5) · `LEAN_MEMORY_PATH_TOKENS` (400)

## Tests
`node --test tests/`
