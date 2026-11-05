#!/usr/bin/env node
// SessionStart hook: inject a tiny, budgeted, titles/topics-only index. Details are fetched on demand.
// In a git repo without notes it adds a one-time bootstrap hint (opt out: LEAN_MEMORY_AUTOBOOTSTRAP=0).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAll, stores, buildIndex, bootstrapHint, dirs, readStdinJson } from './lib.mjs';

const input = await readStdinJson();

/** Saving is the weak link (Claude rarely saves unprompted): remind once per session start when notes are stale but the repo moved on. */
function staleNudge(all, root) {
  if (process.env.LEAN_MEMORY_NUDGE === '0' || input.source === 'compact' || !all.project) return '';
  const last = all.project.db.prepare('SELECT MAX(updated) u, COUNT(*) c FROM notes').get();
  if (!last.c || !last.u) return '';
  const ageH = (Date.now() - Date.parse(last.u)) / 36e5;
  if (!(ageH >= 24)) return '';
  const r = spawnSync('git', ['rev-list', '--count', `--since=${last.u}`, 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 3000 });
  const n = r.status === 0 ? Number(r.stdout.trim()) : 0;
  if (n < (Number(process.env.LEAN_MEMORY_NUDGE_COMMITS) || 8)) return '';
  const age = ageH < 48 ? `${Math.round(ageH)} h` : `${Math.round(ageH / 24)} d`;
  return `[memory] Notes last updated ${age} ago, ${n} commits since. If those changes brought non-obvious decisions, gotchas or conventions, save them with add; otherwise ignore this.`;
}

const all = openAll(input.cwd);
const mem = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mem.mjs');
const parts = [];
if (stores(all).length) parts.push(buildIndex(all, mem));
const nudge = staleNudge(all, dirs(input.cwd).root);
if (nudge) parts.push(nudge);

const projectEmpty = !all.project || all.project.db.prepare('SELECT COUNT(*) c FROM notes').get().c === 0;
if (projectEmpty && process.env.LEAN_MEMORY_AUTOBOOTSTRAP !== '0' && fs.existsSync(path.join(dirs(input.cwd).root, '.git'))) parts.push(bootstrapHint(mem));

if (!parts.length) process.exit(0);
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n') } }));
