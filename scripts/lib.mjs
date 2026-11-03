// lean-memory core: storage, search (BM25), index building. Zero dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const LIMITS = { title: 80, body: 500 };
export const TYPES = ['decision', 'fact', 'pref', 'gotcha', 'todo'];
export const estTokens = (s) => Math.ceil(s.length / 4);

const STOP = new Set(('a an the and or but if of to in on at by for with from as is are was were be been it its this that these those i you we they he she ' +
  'do does did can could should would will not no yes so than then there here what which who how why when where my your our ' +
  'der die das und oder aber wenn von zu in im am an auf bei für mit aus als ist sind war waren sein es ein eine einen einem einer eines ' +
  'ich du wir ihr sie nicht kein keine nur auch noch dann dass wie was wer wo warum mein dein unser bitte mal kannst kann soll sollte').split(' '));

export function tokenize(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 6 ? t.slice(0, 6) : t)); // cheap stemming by truncation
}

export function dirs(cwd) {
  const project = process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd();
  return {
    project: process.env.LEAN_MEMORY_DIR || path.join(project, '.claude', 'memory'),
    global: process.env.LEAN_MEMORY_GLOBAL_DIR || process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'memory'),
  };
}

const fileOf = (dir) => path.join(dir, 'memories.jsonl');

export function load(dir, scope) {
  let raw;
  try { raw = fs.readFileSync(fileOf(dir), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); e.scope = scope; out.push(e); } catch { /* skip corrupt line */ }
  }
  return out;
}

export function save(dir, entries) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fileOf(dir) + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, entries.map(({ scope, ...e }) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  fs.renameSync(tmp, fileOf(dir));
}

export function loadAll(cwd) {
  const d = dirs(cwd);
  return { d, project: load(d.project, 'project'), global: load(d.global, 'global') };
}

export const shortId = (e) => (e.scope === 'global' ? 'g-' : '') + e.id;

export function findById(all, ref) {
  const gl = ref.startsWith('g-');
  const id = gl ? ref.slice(2) : ref;
  return (gl ? all.global : all.project).find((e) => e.id === id);
}

const docTokens = (e) => [...tokenize(e.title), ...tokenize(e.title), ...tokenize((e.tags || []).join(' ')), ...tokenize((e.tags || []).join(' ')), ...tokenize(e.body)];

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let i = 0; for (const t of A) if (B.has(t)) i++;
  return A.size + B.size - i === 0 ? 0 : i / (A.size + B.size - i);
}

export function findSimilar(entries, title, body) {
  const t = [...tokenize(title), ...tokenize(body)];
  let best = null, bestScore = 0;
  for (const e of entries) {
    const s = jaccard(t, [...tokenize(e.title), ...tokenize(e.body)]);
    if (s > bestScore) { best = e; bestScore = s; }
  }
  return bestScore >= 0.75 ? best : null;
}

export function search(entries, query, { limit = 5 } = {}) {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !entries.length) return [];
  const docs = entries.map((e) => ({ e, toks: docTokens(e) }));
  const avg = docs.reduce((n, d) => n + d.toks.length, 0) / docs.length || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length, k1 = 1.2, b = 0.75;
  const res = [];
  for (const { e, toks } of docs) {
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0, matched = 0;
    for (const t of q) {
      const f = tf.get(t); if (!f) continue;
      matched++;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks.length) / avg)));
    }
    if (matched) res.push({ e, score, coverage: matched / q.length, matched });
  }
  return res.sort((x, y) => y.score - x.score).slice(0, limit);
}

// Importance for the always-loaded index: pinned > recent > frequently used.
export function rank(e, now = Date.now()) {
  const ageDays = Math.max(0, (now - Date.parse(e.updated || e.created || 0)) / 864e5);
  return (e.pinned ? 1000 : 0) + 10 / (1 + ageDays / 30) + 2 * Math.log2(1 + (e.hits || 0)) + (e.type === 'pref' || e.type === 'gotcha' ? 1 : 0);
}

export function buildIndex(all, scriptPath, { budgetTokens = Number(process.env.LEAN_MEMORY_INDEX_TOKENS) || 500 } = {}) {
  const entries = [...all.project, ...all.global].sort((a, b) => rank(b) - rank(a));
  const head = `[memory] ${entries.length} notes (titles only). Details: node "${scriptPath}" get <id> | search <query>. ` +
    `Save: node "${scriptPath}" add --type decision|fact|pref|gotcha --title "<=${LIMITS.title}ch" --body "<=${LIMITS.body}ch" [--tags a,b] [--global]. ` +
    `Save only durable, non-obvious facts not derivable from code; reuse existing notes instead of duplicating.`;
  let budget = budgetTokens * 4 - head.length;
  const lines = [];
  let shown = 0;
  for (const e of entries) {
    const line = `${shortId(e)} ${e.type[0]}${e.pinned ? '*' : ''} ${e.title}`;
    if (budget - line.length - 1 < 40) break;
    lines.push(line); budget -= line.length + 1; shown++;
  }
  const more = entries.length - shown;
  return head + (lines.length ? '\n' + lines.join('\n') : '') + (more > 0 ? `\n(+${more} more, use search)` : '');
}

export function newId(existing) {
  let id;
  do { id = crypto.randomBytes(3).toString('hex'); } while (existing.some((e) => e.id === id));
  return id;
}
