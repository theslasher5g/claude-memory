import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-'));
const env = { ...process.env, CLAUDE_PROJECT_DIR: tmp, LEAN_MEMORY_DIR: path.join(tmp, 'p'), LEAN_MEMORY_GLOBAL_DIR: path.join(tmp, 'g') };
const run = (script, args = [], input) => spawnSync('node', [path.join(root, 'scripts', script), ...args], { env, input, encoding: 'utf8', cwd: tmp });
const mem = (...a) => run('mem.mjs', a);
const ctx = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '');
const sid = () => 'sid' + Math.random().toString(36).slice(2);

test('add, dedupe, search, get (counts hits), forget', () => {
  assert.match(mem('add', '--title', 'Use pnpm', '--body', 'workspaces need pnpm').stdout, /^saved/);
  assert.match(mem('add', '--title', 'Use pnpm', '--body', 'workspaces need pnpm always').stdout, /^updated/);
  const id = mem('list').stdout.split(' ')[0];
  assert.match(mem('search', 'pnpm workspaces').stdout, /Use pnpm/);
  assert.match(mem('get', id).stdout, /workspaces need pnpm always/);
  assert.match(mem('forget', id).stdout, /forgot/);
  assert.equal(mem('list').stdout.trim(), 'empty');
});

test('rejects oversized notes', () => {
  assert.notEqual(mem('add', '--title', 'x', '--body', 'y'.repeat(600)).status, 0);
});

test('parallel writers do not lose notes (SQLite WAL + transactions)', async () => {
  const words = ['amber', 'basalt', 'cobalt', 'dune', 'ember', 'fjord', 'gale', 'heron'];
  await Promise.all(words.map((w, i) => new Promise((res) => {
    spawn('node', [path.join(root, 'scripts/mem.mjs'), 'add', '--title', `${w} unique-${w}${i}`, '--body', `${w}${w} ${w}x${i} only`, '--topic', 'par'], { env, cwd: tmp }).on('close', res);
  })));
  assert.equal(mem('list', '--topic', 'par').stdout.trim().split('\n').length, words.length);
});

test('index: flat while it fits, topics + budget once it does not', () => {
  const small = ctx(run('session-start.mjs', [], '{}'));
  assert.doesNotMatch(small, /topics \(search/);
  const w = ['falcon', 'granite', 'harbor', 'island', 'jungle', 'kettle', 'lantern', 'meadow', 'nectar', 'orchid'];
  const rows = [];
  for (let i = 0; i < 120; i++) {
    const a = w[i % 10], b = w[Math.floor(i / 10) % 8], c = 'zq' + i.toString(36) + 'x'.repeat(i % 5);
    rows.push(['add', '--title', `${a} ${b} ${c} routing rule ${c}`, '--body', `${b} ${a} ${c} detail${c} ${a}${a}`, '--topic', ['billing', 'auth', 'deploy'][i % 3]]);
  }
  rows.forEach((r) => mem(...r));
  const big = ctx(run('session-start.mjs', [], '{}'));
  assert.ok(big.length / 4 <= 520, `index too big: ${big.length / 4} tokens`);
  assert.match(big, /topics \(search --topic <t>\): .*billing\(\d+\)/);
  assert.match(big, /more, use search/);
  assert.match(mem('search', 'routing', '--topic', 'auth', '--limit', '2').stdout, /\[fact\]/);
});

test('index is byte-stable across runs (prompt-cache friendly)', () => {
  assert.equal(ctx(run('session-start.mjs', [], '{}')), ctx(run('session-start.mjs', [], '{}')));
});

test('prompt hook: silent on weak match, injects strong match once', () => {
  mem('add', '--title', 'Tests need Postgres on 5433', '--body', 'integration tests use port 5433', '--tags', 'postgres');
  const p = JSON.stringify({ prompt: 'why do integration tests fail on postgres port?', session_id: sid(), cwd: tmp });
  const p2 = JSON.parse(p);
  assert.match(ctx(run('prompt-submit.mjs', [], p)), /5433/);
  assert.equal(run('prompt-submit.mjs', [], p).stdout, ''); // same session_id? new sid each call object -> reuse below
  const s = sid(), q = JSON.stringify({ ...p2, session_id: s });
  assert.match(ctx(run('prompt-submit.mjs', [], q)), /5433/);
  assert.equal(run('prompt-submit.mjs', [], q).stdout, '');
  assert.equal(run('prompt-submit.mjs', [], JSON.stringify({ prompt: 'make the header blue and bigger', session_id: s, cwd: tmp })).stdout, '');
});

test('path-scoped notes: hidden from index, load on matching file, once per session', () => {
  mem('add', '--title', 'Invoices round half-even', '--body', 'never use toFixed in billing code', '--paths', 'src/billing/**,docs/tax.md', '--topic', 'billing');
  assert.doesNotMatch(ctx(run('session-start.mjs', [], '{}')), /Invoices round/);
  assert.match(ctx(run('session-start.mjs', [], '{}')), /path-scoped notes load automatically/);
  const s = sid();
  const ev = (f) => JSON.stringify({ session_id: s, cwd: tmp, tool_name: 'Edit', tool_input: { file_path: path.join(tmp, f) } });
  assert.equal(run('pre-tool-use.mjs', [], ev('src/api/x.ts')).stdout, '');
  assert.match(ctx(run('pre-tool-use.mjs', [], ev('src/billing/deep/tax.ts'))), /half-even/);
  assert.equal(run('pre-tool-use.mjs', [], ev('src/billing/tax.ts')).stdout, '');
  assert.match(ctx(run('pre-tool-use.mjs', [], JSON.stringify({ session_id: sid(), cwd: tmp, tool_input: { file_path: path.join(tmp, 'docs/tax.md') } }))), /half-even/);
});

test('hooks create nothing and stay silent when no memory exists', () => {
  const e2 = { ...env, LEAN_MEMORY_DIR: path.join(tmp, 'none-p'), LEAN_MEMORY_GLOBAL_DIR: path.join(tmp, 'none-g') };
  const r = spawnSync('node', [path.join(root, 'scripts/session-start.mjs')], { env: e2, input: '{}', encoding: 'utf8' });
  assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  assert.ok(!fs.existsSync(e2.LEAN_MEMORY_DIR));
});

test('migrates legacy memories.jsonl', () => {
  const d = path.join(tmp, 'legacy'); fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'memories.jsonl'), JSON.stringify({ id: 'abc123', type: 'fact', title: 'Legacy note kiwi', body: 'old format kiwi', tags: ['old'], created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', hits: 2, pinned: false }) + '\n');
  const r = spawnSync('node', [path.join(root, 'scripts/mem.mjs'), 'search', 'kiwi'], { env: { ...env, LEAN_MEMORY_DIR: d }, encoding: 'utf8', cwd: tmp });
  assert.match(r.stdout, /Legacy note kiwi/);
  assert.ok(fs.existsSync(path.join(d, 'memories.jsonl.migrated')));
});
