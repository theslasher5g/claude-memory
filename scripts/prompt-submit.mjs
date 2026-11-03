#!/usr/bin/env node
// UserPromptSubmit hook: inject at most a few *highly* relevant notes, never the same note twice per session.
// Silent (zero tokens) unless the match is strong.
import { openAll, stores, search, shortId, estTokens, seenLoad, seenAdd, readStdinJson } from './lib.mjs';

const MAX_HITS = Number(process.env.LEAN_MEMORY_MAX_HITS) || 3;
const MAX_TOKENS = Number(process.env.LEAN_MEMORY_PROMPT_TOKENS) || 250;

const input = await readStdinJson();
const prompt = String(input.prompt || '');
if (prompt.length < 12 || prompt.startsWith('/')) process.exit(0);
const all = openAll(input.cwd);
if (!stores(all).length) process.exit(0);

const seen = seenLoad(input.session_id);
const hits = search(all, prompt, { limit: 10 })
  .filter((r) => !seen.includes(shortId(r.e)))
  // strong-match gate: >= half of the query terms covered, and either 2+ terms or a single term found in title/tags
  .filter((r) => r.coverage >= 0.5 && (r.matched >= 2 || (r.coverage === 1 && r.inTitle)))
  .slice(0, MAX_HITS);

let out = '[memory: relevant notes]';
const used = [];
for (const r of hits) {
  const line = `\n${shortId(r.e)} ${r.e.title}: ${r.e.body}`;
  if (estTokens(out + line) > MAX_TOKENS) break;
  out += line; used.push(shortId(r.e));
}
if (!used.length) process.exit(0);
seenAdd(input.session_id, used);
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: out } }));
