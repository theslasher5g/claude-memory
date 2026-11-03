#!/usr/bin/env node
// PreToolUse hook: load path-scoped notes when Claude touches a matching file or names a matching path.
// Covers Read/Edit/Write (file_path), Grep/Glob (path, glob/pattern) and Bash (paths inside the command).
// Zero tokens for anything without scoped notes; each note is injected once per session.
import path from 'node:path';
import { openAll, stores, dirs, pathNotesFor, pathsInCommand, shortId, estTokens, seenLoad, seenAdd, readStdinJson } from './lib.mjs';

const MAX_NOTES = Number(process.env.LEAN_MEMORY_PATH_NOTES) || 5;
const MAX_TOKENS = Number(process.env.LEAN_MEMORY_PATH_TOKENS) || 400;

const input = await readStdinJson();
const ti = input.tool_input || {};
const root = dirs(input.cwd).root;
const rel = (f) => { const r = path.relative(root, path.resolve(input.cwd || process.cwd(), f)).split(path.sep).join('/'); return r && !r.startsWith('..') ? r : ''; };

let candidates = [];
if (input.tool_name === 'Bash') candidates = pathsInCommand(ti.command || '', root);
else {
  for (const f of [ti.file_path, ti.notebook_path, ti.path]) if (f) candidates.push(rel(f));
  for (const g of [ti.glob, ti.pattern]) if (typeof g === 'string' && input.tool_name === 'Glob' && /[\/.]/.test(g)) candidates.push(g.replace(/^\.?\//, '').split(/[*?]/)[0].replace(/\/+$/, ''));
}
candidates = [...new Set(candidates.filter(Boolean))];
if (!candidates.length) process.exit(0);

const all = openAll(input.cwd);
if (!stores(all).length) process.exit(0);

const seen = seenLoad(input.session_id);
const notes = pathNotesFor(all, candidates).filter((e) => !seen.includes(shortId(e))).slice(0, MAX_NOTES);
let out = `[memory: notes for ${candidates[0]}${candidates.length > 1 ? ' +' + (candidates.length - 1) : ''}]`;
const used = [];
for (const e of notes) {
  const line = `\n${shortId(e)} ${e.title}: ${e.body}`;
  if (estTokens(out + line) > MAX_TOKENS) break;
  out += line; used.push(shortId(e));
}
if (!used.length) process.exit(0);
seenAdd(input.session_id, used);
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: out } }));
