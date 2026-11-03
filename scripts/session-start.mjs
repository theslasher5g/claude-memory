#!/usr/bin/env node
// SessionStart hook: inject a tiny, budgeted, titles/topics-only index. Details are fetched on demand.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openAll, stores, buildIndex, readStdinJson } from './lib.mjs';

const input = await readStdinJson();
const all = openAll(input.cwd);
if (!stores(all).length) process.exit(0);
const mem = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mem.mjs');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: buildIndex(all, mem) } }));
