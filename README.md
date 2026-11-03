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

## Speicherort & Git
- **Projekt:** `.claude/memory/notes.jsonl` ist die **Wahrheit und wird committet** (eine Notiz pro Zeile, nach ID sortiert → merge-freundlich, ohne lokale Zähler). `memory.db` daneben ist nur ein lokaler Cache; das Plugin legt dafür selbst eine `.gitignore` an. Der Cache baut sich nach Clone, Pull oder Branch-Wechsel automatisch neu auf.
- **Wichtig für Cloud-Sessions und Teams:** Cloud-Sessions starten mit einem frischen Klon. Gemerkt wird nur, was auf dem Branch liegt, von dem die Session startet – `notes.jsonl` also nach `main` mergen.
- **Global (`--global`):** `~/.claude/memory/memory.db`, nicht in Git (persönliche Vorlieben).
- Überschreibbar: `LEAN_MEMORY_DIR`, `LEAN_MEMORY_GLOBAL_DIR`.

## Automatischer Start in neuen Repos
Gibt es in einem Git-Repo noch keine Notizen, hängt der Sessionstart-Hook einmalig einen kurzen Hinweis an (~70 Tokens). Claude erledigt danach seine erste Aufgabe und führt dann `/lean-memory:bootstrap` aus: begrenzt (~10 Lesezugriffe, max. 25 Notizen), nur Nicht-Ableitbares, feste Themenliste, Pfad-Bindung für Ordnerregeln. Danach verschwindet der Hinweis. Abschalten: `LEAN_MEMORY_AUTOBOOTSTRAP=0`. Der Bootstrap kostet einmalig Tokens für die Erkundung.

## Messung: spart es wirklich Tokens?

Gemessen an einem echten Repo (aurora-ssh, Rust, 30 Notizen, davon 24 pfadgebunden) mit `claude -p` headless, 3 Läufe je Frage und Variante (18 Läufe), gleiche schreibgeschützte Werkzeuge, gleiches Modell. **Ohne Plugin** heißt: Repo-Stand vor den Notizen, kein `lean-memory` geladen. **Mit Plugin:** Version 0.3.0, Notizen als `notes.jsonl`.

| Frage | Notizen passen? | Kosten ohne → mit | Zeit | Werkzeug-Aufrufe |
|---|---|---|---|---|
| Release veröffentlichen | ja, direkt | $0.207 → $0.085 (**−59 %**) | 24 s → 16 s | 4 → 1,3 |
| RDP-Laufwerk ergänzen, bauen und testen | teilweise | $0.254 → $0.206 (**−19 %**) | 44 s → 32 s | 7,3 → 5,7 |
| Hauptdatei und Rust-Edition finden | nein | $0.078 → $0.076 (**−2 %**) | 11 s → 11 s | 2 → 1,7 |
| **Alle** | | $0.180 → $0.122 (**−32 %**) | −26 % | 4,4 → 2,9 |

- **Wo es spart:** Bei Fragen, zu denen es passende Notizen gibt. Claude kennt dann die richtigen Stellen und liest gezielt statt das Repo zu durchsuchen. Bei Fragen ohne Bezug zu den Notizen ist der Aufwand des Plugins (Index ca. 230 Tokens pro Sessionstart) im Rauschen nicht messbar.
- **Qualität:** Etwa gleich. Eine Prüfung gegen je 8 im Repo belegte Fakten ergab Ø 5,0 (mit) gegen 5,3 (ohne) bei der Release-Frage und Ø 5,7 gegen 6,0 bei der RDP-Frage. Das Plugin macht die Antworten nicht besser, nur den Weg dorthin günstiger. Auch mit Plugin fehlte bei der Release-Frage die Signierreihenfolge aus den Notizen.
- **Kosten** sind der aussagekräftigste Wert, weil Cache-Lesezugriffe günstiger berechnet werden. Der reine Kontextverbrauch lag im Mittel bei 192.000 → 129.000 Tokens (−33 %), enthält aber bei jedem Zug die Grundlast von ca. 41.000 Tokens.

**Grenzen:** Nur 3 Läufe je Zelle bei großer Streuung (RDP ohne Plugin: 199.000 bis 368.000 Tokens), die Richtung ist klar, die genauen Prozente nicht. Zwei der drei Fragen sind passend zu den Notizen gewählt, im Alltag überwiegen Fragen ohne Treffer, also eher 0 bis 59 % pro Frage als pauschal 32 %. Die Faktenprüfung arbeitet mit Textmustern, nicht mit einer echten Bewertung. Ein Repo, ein Modell, nur headless, keine interaktive Session.

**Aufbau, damit der Vergleich fair ist:** Beide Varianten laufen mit eigener, leerer Konfiguration und abgeschalteter Plugin-/Skill-Synchronisierung (`CLAUDE_CODE_SYNC_PLUGINS=0`). Der Repo-Stand ohne Notizen enthält auch in der Git-Historie keine Spur davon. Zwei frühere Messreihen waren verfälscht (Plugin über die Kontosynchronisierung geladen, Notizen über `git show HEAD` gefunden) und sind verworfen. Wer nachmessen will, muss beides ausschließen und im Lauf prüfen, welche Plugins geladen sind.

## Installation
```
/plugin marketplace add theslasher5g/claude-memory
/plugin install lean-memory@claude-memory
```

## Nutzung
- `/lean-memory:bootstrap` (Erstbefüllung) · `/lean-memory:remember <text>` · `/lean-memory:recall <query>` · `/lean-memory:forget <id>`
- CLI (nutzt Claude selbst, siehe `skills/memory/SKILL.md`):
  `node scripts/mem.mjs add|search|get|list|topics|forget|pin|unpin|index|stats|prune`
- Beispiel Pfad-Scoping: `add --title "Rundung half-even" --body "…" --paths "src/billing/**" --topic billing`
- `stats` zeigt Session-Start-Kosten in Tokens.

## Einstellungen (Env)
`LEAN_MEMORY_INDEX_TOKENS` (500) · `LEAN_MEMORY_MAX_HITS` (3) · `LEAN_MEMORY_PROMPT_TOKENS` (250) · `LEAN_MEMORY_PATH_NOTES` (5) · `LEAN_MEMORY_PATH_TOKENS` (400)

## Tests
`node --test`
