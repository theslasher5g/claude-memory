#!/usr/bin/env node
// PreToolUse hook (Read/Edit/Write/...): load path-scoped notes when Claude touches a matching file.
// Zero tokens for files without scoped notes; each note is injected once per session.
import path from 'node:path';
import { openAll, stores, dirs, pathNotes, shortId, estTokens, seenLoad, seenAdd, readStdinJson } from './lib.mjs';

const MAX_NOTES = Number(process.env.LEAN_MEMORY_PATH_NOTES) || 5;
const MAX_TOKENS = Number(process.env.LEAN_MEMORY_PATH_TOKENS) || 400;

const input = await readStdinJson();
const file = input.tool_input?.file_path || input.tool_input?.notebook_path || input.tool_input?.path;
if (!file) process.exit(0);
const all = openAll(input.cwd);
if (!stores(all).length) process.exit(0);

const rel = path.relative(dirs(input.cwd).root, path.resolve(input.cwd || process.cwd(), file)).split(path.sep).join('/');
if (!rel || rel.startsWith('..')) process.exit(0);

const seen = seenLoad(input.session_id);
const notes = pathNotes(all, rel).filter((e) => !seen.includes(shortId(e))).slice(0, MAX_NOTES);
let out = `[memory: notes for ${rel}]`;
const used = [];
for (const e of notes) {
  const line = `\n${shortId(e)} ${e.title}: ${e.body}`;
  if (estTokens(out + line) > MAX_TOKENS) break;
  out += line; used.push(shortId(e));
}
if (!used.length) process.exit(0);
seenAdd(input.session_id, used);
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: out } }));
