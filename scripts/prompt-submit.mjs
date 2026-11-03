#!/usr/bin/env node
// UserPromptSubmit hook: inject at most a few *highly* relevant notes, never the same note twice per session.
// Silent (zero tokens) unless the match is strong.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAll, search, shortId, estTokens } from './lib.mjs';

const MAX_HITS = Number(process.env.LEAN_MEMORY_MAX_HITS) || 3;
const MAX_TOKENS = Number(process.env.LEAN_MEMORY_PROMPT_TOKENS) || 250;

let input = {};
try { input = JSON.parse(await new Promise((r) => { let s = ''; process.stdin.on('data', (c) => (s += c)); process.stdin.on('end', () => r(s || '{}')); })); } catch { process.exit(0); }

const prompt = String(input.prompt || '');
if (prompt.length < 12 || prompt.startsWith('/')) process.exit(0);

const all = loadAll(input.cwd);
const entries = [...all.project, ...all.global];
if (!entries.length) process.exit(0);

const seenFile = path.join(os.tmpdir(), `lean-memory-${String(input.session_id || 'x').replace(/\W/g, '')}.json`);
let seen = [];
try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')); } catch { /* first prompt */ }

const hits = search(entries, prompt, { limit: 10 })
  .filter((r) => !seen.includes(shortId(r.e)))
  // strong-match gate: >=2 matched terms (or the only term) and at least half the query terms covered
  .filter((r) => r.coverage >= 0.5 && (r.matched >= 2 || r.coverage === 1) && r.score >= 2.5)
  .slice(0, MAX_HITS);
if (!hits.length) process.exit(0);

let out = '[memory: relevant notes]';
const used = [];
for (const r of hits) {
  const line = `\n${shortId(r.e)} ${r.e.title}: ${r.e.body}`;
  if (estTokens(out + line) > MAX_TOKENS) break;
  out += line; used.push(shortId(r.e));
}
if (!used.length) process.exit(0);

try { fs.writeFileSync(seenFile, JSON.stringify([...seen, ...used])); } catch { /* best effort */ }
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: out } }));
