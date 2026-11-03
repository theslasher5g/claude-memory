import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-'));
const env = { ...process.env, LEAN_MEMORY_DIR: path.join(tmp, 'p'), LEAN_MEMORY_GLOBAL_DIR: path.join(tmp, 'g') };
const run = (script, args = [], input) => spawnSync('node', [path.join(root, 'scripts', script), ...args], { env, input, encoding: 'utf8' });
const mem = (...a) => run('mem.mjs', a);

test('add, dedupe, search, get, forget', () => {
  assert.match(mem('add', '--title', 'Use pnpm', '--body', 'workspaces need pnpm').stdout, /^saved/);
  assert.match(mem('add', '--title', 'Use pnpm', '--body', 'workspaces need pnpm always').stdout, /^updated/);
  const id = mem('list').stdout.split(' ')[0];
  assert.match(mem('search', 'pnpm workspaces').stdout, /Use pnpm/);
  assert.match(mem('get', id).stdout, /workspaces need pnpm always/);
  assert.match(mem('forget', id).stdout, /forgot/);
  assert.equal(mem('list').stdout.trim(), 'empty');
});

test('rejects oversized notes', () => {
  const r = mem('add', '--title', 'x', '--body', 'y'.repeat(600));
  assert.notEqual(r.status, 0);
});

test('index respects token budget', () => {
  const w = ['falcon','granite','harbor','island','jungle','kettle','lantern','meadow','nectar','orchid'];
  for (let i = 0; i < 80; i++) {
    const a = w[i % 10], b = w[Math.floor(i / 10) % 8], c = 'zq' + i.toString(36) + 'x'.repeat(i % 5);
    mem('add', '--title', `${a} ${b} ${c} routing rule ${c}`, '--body', `${b} ${a} ${c} detail${c} ${a}${a}`);
  }
  const out = JSON.parse(run('session-start.mjs', [], '{}').stdout).hookSpecificOutput.additionalContext;
  assert.ok(out.length / 4 <= 520, `index too big: ${out.length / 4} tokens`);
  assert.match(out, /more, use search/);
});

test('prompt hook is silent on weak match and does not repeat', () => {
  mem('add', '--title', 'Tests need Postgres on 5433', '--body', 'integration tests use port 5433');
  const p = JSON.stringify({ prompt: 'why do integration tests fail on postgres port?', session_id: 'tt' + Date.now() });
  const first = run('prompt-submit.mjs', [], p).stdout;
  assert.match(first, /5433/);
  assert.equal(run('prompt-submit.mjs', [], p).stdout, '');
  assert.equal(run('prompt-submit.mjs', [], JSON.stringify({ prompt: 'make the header blue and bigger', session_id: 'zz' })).stdout, '');
});
