#!/usr/bin/env node
// SessionStart hook: inject a tiny, budgeted, titles-only index. Details are fetched on demand.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadAll, buildIndex } from './lib.mjs';

let input = {};
try { input = JSON.parse(await new Promise((r) => { let s = ''; process.stdin.on('data', (c) => (s += c)); process.stdin.on('end', () => r(s || '{}')); })); } catch { /* ignore */ }

const mem = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mem.mjs');
const text = buildIndex(loadAll(input.cwd), mem);
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
