# lean-memory – token-effizientes Gedächtnis für Claude Code

Ziel: Claude erinnert sich an Entscheidungen, Stolperfallen und Präferenzen, **ohne** dass bei jeder Session ein großer Memory-Block geladen wird.

## Architektur: progressive Offenlegung in 3 Stufen

| Stufe | Wann | Was | Kosten |
|---|---|---|---|
| 1. Index | SessionStart (auch nach `/clear`, `/compact`) | nur Titel, gerankt (pinned > aktuell > oft genutzt), hartes Budget (Standard 500 Tokens) | ~100–500 Tokens, konstant – egal wie viele Notizen existieren |
| 2. Auto-Recall | UserPromptSubmit | max. 3 Notizen, nur bei **starkem** BM25-Treffer, pro Session nie doppelt, Cap 250 Tokens | 0 Tokens bei schwachem Treffer |
| 3. Abruf | on demand (`search` → `get <id>`) | kurze Snippets, dann Volltext nur der benötigten IDs | nur was gebraucht wird |

Weitere Sparhebel:
- **Atomare Notizen mit Hard-Limits** (Titel ≤ 80, Body ≤ 500 Zeichen) – zu lange Notizen werden abgelehnt, Claude muss verdichten.
- **Dedupe/Supersede**: ähnliche Notizen werden zusammengeführt (`--supersede <id>` für gezieltes Ersetzen), kein Wildwuchs.
- **Ranking mit Decay**: Neues und Genutztes bleibt im Index, Altes fällt raus; `prune` entfernt ungenutzte Altlasten.
- **Terse CLI-Ausgabe**: keine Prosa, keine JSON-Hüllen.
- **Zero Dependencies**: nur Node ≥ 18, lokale Suche (BM25, DE/EN-Stopwörter), kein Embedding-/API-Aufruf.

## Speicherort
- Projekt: `<projekt>/.claude/memory/memories.jsonl` (per git teilbar oder ignorieren)
- Global (`--global`, z. B. Sprach-Präferenzen): `~/.claude/memory/memories.jsonl`
- Überschreibbar: `LEAN_MEMORY_DIR`, `LEAN_MEMORY_GLOBAL_DIR`

## Installation
```
/plugin marketplace add theslasher5g/claude-memory
/plugin install lean-memory@claude-memory
```

## Nutzung
- `/lean-memory:remember <text>` · `/lean-memory:recall <query>` · `/lean-memory:forget <id>`
- Claude nutzt das CLI selbstständig (siehe `skills/memory/SKILL.md`):
  `node scripts/mem.mjs add|search|get|list|forget|pin|unpin|index|stats|prune`
- `stats` zeigt die aktuellen Session-Start-Kosten in Tokens.

## Einstellungen (Env)
`LEAN_MEMORY_INDEX_TOKENS` (500) · `LEAN_MEMORY_MAX_HITS` (3) · `LEAN_MEMORY_PROMPT_TOKENS` (250)

## Tests
`node --test tests/`
