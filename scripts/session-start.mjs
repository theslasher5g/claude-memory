#!/usr/bin/env node
// SessionStart hook: inject a tiny, budgeted, titles/topics-only index. Details are fetched on demand.
// In a git repo without notes it adds a one-time bootstrap hint (opt out: LEAN_MEMORY_AUTOBOOTSTRAP=0).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAll, stores, buildIndex, bootstrapHint, dirs, readStdinJson } from './lib.mjs';

const input = await readStdinJson();
const all = openAll(input.cwd);
const mem = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mem.mjs');
const parts = [];
if (stores(all).length) parts.push(buildIndex(all, mem));

const projectEmpty = !all.project || all.project.db.prepare('SELECT COUNT(*) c FROM notes').get().c === 0;
if (projectEmpty && process.env.LEAN_MEMORY_AUTOBOOTSTRAP !== '0' && fs.existsSync(path.join(dirs(input.cwd).root, '.git'))) parts.push(bootstrapHint(mem));

if (!parts.length) process.exit(0);
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n') } }));
