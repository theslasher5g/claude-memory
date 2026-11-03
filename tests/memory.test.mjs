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

// ---- git-tracked source of truth + bootstrap hint ----
function repo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'lmrepo-'));
  fs.mkdirSync(path.join(r, '.git'));
  const e = { ...process.env, CLAUDE_PROJECT_DIR: r, LEAN_MEMORY_GLOBAL_DIR: path.join(r, '_g') };
  delete e.LEAN_MEMORY_DIR;
  const sh = (script, args = [], input) => spawnSync('node', [path.join(root, 'scripts', script), ...args], { env: e, input, encoding: 'utf8', cwd: r });
  return { r, sh, mem: (...a) => sh('mem.mjs', a), dir: path.join(r, '.claude', 'memory') };
}

test('notes.jsonl is written (sorted, no hit counters) and memory.db is git-ignored', () => {
  const { mem, dir } = repo();
  mem('add', '--title', 'Zeta rule', '--body', 'zeta body unique1', '--topic', 'build');
  mem('add', '--title', 'Alpha rule', '--body', 'alpha body unique2', '--topic', 'build');
  const id = mem('list').stdout.split(' ')[0];
  mem('get', id); // bumps local hits only
  const lines = fs.readFileSync(path.join(dir, 'notes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.id), lines.map((l) => l.id).sort());
  assert.ok(!('hits' in lines[0]));
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /memory\.db/);
});

test('fresh clone: db is rebuilt from notes.jsonl; later edits to the file are picked up', () => {
  const { mem, dir } = repo();
  mem('add', '--title', 'Use SQLite not Postgres', '--body', 'raspberry pi has little ram', '--tags', 'data');
  for (const f of ['memory.db', 'memory.db-wal', 'memory.db-shm']) fs.rmSync(path.join(dir, f), { force: true });
  assert.match(mem('search', 'sqlite raspberry').stdout, /Use SQLite not Postgres/);
  // simulate a pull that adds a note
  const extra = { id: 'ffffff', type: 'fact', title: 'Pulled note quince', body: 'quince arrived via git pull', tags: [], topic: 'misc', paths: [], created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', pinned: false };
  fs.appendFileSync(path.join(dir, 'notes.jsonl'), JSON.stringify(extra) + '\n');
  assert.match(mem('search', 'quince').stdout, /Pulled note quince/);
  // forget removes it from the file too
  mem('forget', 'ffffff');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'notes.jsonl'), 'utf8'), /ffffff/);
});

test('bootstrap hint: only in a git repo without notes, once notes exist it disappears', () => {
  const a = repo();
  const hint = ctx(a.sh('session-start.mjs', [], '{}'));
  assert.match(hint, /No notes for this repo yet/);
  assert.match(hint, /lean-memory:bootstrap/);
  a.mem('add', '--title', 'First note apple', '--body', 'apple body');
  assert.doesNotMatch(ctx(a.sh('session-start.mjs', [], '{}')), /No notes for this repo yet/);
  // opt-out and non-git dirs stay silent
  const b = repo();
  const off = spawnSync('node', [path.join(root, 'scripts/session-start.mjs')], { env: { ...process.env, CLAUDE_PROJECT_DIR: b.r, LEAN_MEMORY_GLOBAL_DIR: path.join(b.r, '_g'), LEAN_MEMORY_AUTOBOOTSTRAP: '0' }, input: '{}', encoding: 'utf8', cwd: b.r });
  assert.equal(off.stdout, '');
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'lmplain-'));
  const q = spawnSync('node', [path.join(root, 'scripts/session-start.mjs')], { env: { ...process.env, CLAUDE_PROJECT_DIR: plain, LEAN_MEMORY_GLOBAL_DIR: path.join(plain, '_g') }, input: '{}', encoding: 'utf8', cwd: plain });
  assert.equal(q.stdout, '');
});
