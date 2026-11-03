// lean-memory core on node:sqlite (FTS5/BM25). Zero npm dependencies, needs Node >= 22.5.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// node:sqlite prints an ExperimentalWarning on some Node versions; keep hook stderr clean.
const _emit = process.emitWarning;
process.emitWarning = (w, ...a) => {
  const type = typeof a[0] === 'string' ? a[0] : a[0]?.type;
  if (type === 'ExperimentalWarning' || w?.name === 'ExperimentalWarning') return;
  return _emit.call(process, w, ...a);
};
const { DatabaseSync } = await import('node:sqlite');

export const LIMITS = { title: 80, body: 500 };
export const TYPES = ['decision', 'fact', 'pref', 'gotcha', 'todo'];
export const estTokens = (s) => Math.ceil(s.length / 4);

const STOP = new Set(('a an the and or but if of to in on at by for with from as is are was were be been it its this that these those i you we they he she ' +
  'do does did can could should would will not no yes so than then there here what which who how why when where my your our ' +
  'der die das und oder aber wenn von zu in im am an auf bei für mit aus als ist sind war waren sein es ein eine einen einem einer eines ' +
  'ich du wir ihr sie nicht kein keine nur auch noch dann dass wie was wer wo warum mein dein unser bitte mal kannst kann soll sollte').split(' '));

export function tokenize(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 6 ? t.slice(0, 6) : t)); // cheap stemming by truncation
}
const norm = (s) => tokenize(s).join(' ');

export function dirs(cwd) {
  const project = process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd();
  return {
    root: project,
    project: process.env.LEAN_MEMORY_DIR || path.join(project, '.claude', 'memory'),
    global: process.env.LEAN_MEMORY_GLOBAL_DIR || process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'memory'),
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes(
  n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
  type TEXT, title TEXT, body TEXT, tags TEXT DEFAULT '', topic TEXT DEFAULT 'misc', paths TEXT DEFAULT '',
  created TEXT, updated TEXT, pinned INTEGER DEFAULT 0, hits INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS notes_topic ON notes(topic);
CREATE INDEX IF NOT EXISTS notes_paths ON notes(paths) WHERE paths != '';
CREATE INDEX IF NOT EXISTS notes_updated ON notes(updated);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, tags, body);`;

/**
 * Open a store. Read-only callers (hooks) pass create:false and get null when nothing exists yet.
 * Project scope: `notes.jsonl` (tracked in git, sorted by id, merge-friendly) is the source of truth;
 * `memory.db` is a local, git-ignored cache that is rebuilt whenever notes.jsonl changed (fresh clone, pull, branch switch).
 */
export function openStore(dir, scope, { create = false } = {}) {
  const file = path.join(dir, 'memory.db');
  const legacy = path.join(dir, 'memories.jsonl');
  const jsonl = scope === 'project' ? path.join(dir, 'notes.jsonl') : null;
  if (!fs.existsSync(file) && !create && !fs.existsSync(legacy) && !(jsonl && fs.existsSync(jsonl))) return null;
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=5000'); // must come first so concurrent first-time opens wait instead of failing
  for (let attempt = 0; ; attempt++) {
    try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;'); db.exec(SCHEMA); break; } catch (e) {
      if (attempt >= 5 || !/locked|busy/i.test(String(e.message))) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
  const store = { db, scope, dir, file, jsonl };
  if (jsonl) {
    const gi = path.join(dir, '.gitignore');
    if (!fs.existsSync(gi)) { try { fs.writeFileSync(gi, 'memory.db\nmemory.db-wal\nmemory.db-shm\n'); } catch { /* best effort */ } }
  }
  if (fs.existsSync(legacy)) migrate(store, legacy);
  syncFromJsonl(store);
  return store;
}

const sigOf = (f) => { try { const st = fs.statSync(f); return `${st.size}:${Math.floor(st.mtimeMs)}`; } catch { return null; } };
const metaGet = (db, k) => db.prepare('SELECT v FROM meta WHERE k=?').get(k)?.v;
const metaSet = (db, k, v) => db.prepare('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)').run(k, v);

/** Rebuild the SQLite cache from notes.jsonl when the file changed since we last saw it. Local hit counters survive. */
function syncFromJsonl(store) {
  if (!store.jsonl) return;
  const sig = sigOf(store.jsonl);
  if (!sig || metaGet(store.db, 'jsonl_sig') === sig) return;
  const rows = fs.readFileSync(store.jsonl, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.id && e.title);
  tx(store.db, () => {
    if (metaGet(store.db, 'jsonl_sig') === sig) return; // another process already synced
    const hits = new Map(store.db.prepare('SELECT id,hits FROM notes').all().map((r) => [r.id, r.hits]));
    store.db.exec('DELETE FROM notes; DELETE FROM fts;');
    for (const e of rows) insert(store, { ...e, tags: e.tags || [], paths: e.paths || [], hits: hits.get(e.id) || 0 });
    metaSet(store.db, 'jsonl_sig', sig);
  });
}

/** Write the committed text file (sorted by id, no local counters) after a content change. */
export function exportJsonl(store) {
  if (!store.jsonl) return;
  const rows = store.db.prepare('SELECT id,type,title,body,tags,topic,paths,created,updated,pinned FROM notes ORDER BY id').all();
  const text = rows.map((r) => JSON.stringify({ ...r, tags: r.tags ? r.tags.split(',') : [], paths: r.paths ? r.paths.split(',') : [], pinned: !!r.pinned })).join('\n') + (rows.length ? '\n' : '');
  const tmp = `${store.jsonl}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, store.jsonl);
  metaSet(store.db, 'jsonl_sig', sigOf(store.jsonl));
}

/** Transaction + export. Use for every content change (not for hit counters). */
export function write(store, fn) {
  const r = tx(store.db, fn);
  exportJsonl(store);
  return r;
}

function migrate(store, legacy) {
  try {
    const rows = fs.readFileSync(legacy, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    tx(store.db, () => { for (const e of rows) if (!getById(store, e.id)) insert(store, { ...e, tags: e.tags || [], paths: [], topic: e.tags?.[0] }); });
    fs.renameSync(legacy, legacy + '.migrated');
    exportJsonl(store);
  } catch { /* leave the legacy file untouched */ }
}

export function openAll(cwd, opts) {
  const d = dirs(cwd);
  return { d, project: openStore(d.project, 'project', opts), global: openStore(d.global, 'global', opts) };
}
export const stores = (all) => [all.project, all.global].filter(Boolean);

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export { tx };

const toNote = (r, store) => r && ({ ...r, tags: r.tags ? r.tags.split(',') : [], paths: r.paths ? r.paths.split(',') : [], pinned: !!r.pinned, scope: store.scope });
export const shortId = (e) => (e.scope === 'global' ? 'g-' : '') + e.id;

function ftsPut(db, n, e) {
  db.prepare('DELETE FROM fts WHERE rowid=?').run(n);
  db.prepare('INSERT INTO fts(rowid,title,tags,body) VALUES(?,?,?,?)').run(n, norm(e.title), norm((e.tags || []).join(' ')), norm(e.body));
}

export function insert(store, e) {
  const now = new Date().toISOString();
  const tags = e.tags || [];
  const r = store.db.prepare('INSERT INTO notes(id,type,title,body,tags,topic,paths,created,updated,pinned,hits) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(e.id, e.type, e.title, e.body, tags.join(','), e.topic || tags[0] || 'misc', (e.paths || []).join(','), e.created || now, e.updated || now, e.pinned ? 1 : 0, e.hits || 0);
  ftsPut(store.db, Number(r.lastInsertRowid), { ...e, tags });
}

export function update(store, id, patch) {
  const cur = getById(store, id);
  const e = { ...cur, ...patch, updated: new Date().toISOString() };
  store.db.prepare('UPDATE notes SET type=?,title=?,body=?,tags=?,topic=?,paths=?,updated=?,pinned=? WHERE id=?')
    .run(e.type, e.title, e.body, e.tags.join(','), e.topic || e.tags[0] || 'misc', e.paths.join(','), e.updated, e.pinned ? 1 : 0, id);
  ftsPut(store.db, store.db.prepare('SELECT n FROM notes WHERE id=?').get(id).n, e);
}

export function remove(store, id) {
  const r = store.db.prepare('SELECT n FROM notes WHERE id=?').get(id);
  if (!r) return false;
  store.db.prepare('DELETE FROM fts WHERE rowid=?').run(r.n);
  store.db.prepare('DELETE FROM notes WHERE id=?').run(id);
  return true;
}

export const getById = (store, id) => toNote(store.db.prepare('SELECT * FROM notes WHERE id=?').get(id), store);
export const bumpHits = (store, id) => store.db.prepare('UPDATE notes SET hits=hits+1 WHERE id=?').run(id);

export function resolve(all, ref) {
  const gl = ref.startsWith('g-');
  const store = gl ? all.global : all.project;
  const e = store && getById(store, gl ? ref.slice(2) : ref);
  return e ? { store, e } : null;
}

export function newId(store) {
  let id;
  do { id = crypto.randomBytes(3).toString('hex'); } while (getById(store, id));
  return id;
}

const ftsQuery = (toks) => toks.map((t) => `"${t}"`).join(' OR ');

/** BM25 search over FTS5 (title x3, tags x3, body x1). Returns coverage info for gating. */
export function search(all, query, { limit = 5, topic } = {}) {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return [];
  const res = [];
  for (const store of stores(all)) {
    const rows = store.db.prepare(
      `SELECT notes.*, bm25(fts,3,3,1) AS s FROM fts JOIN notes ON notes.n = fts.rowid
       WHERE fts MATCH ? ${topic ? 'AND notes.topic = ?' : ''} ORDER BY s LIMIT ?`)
      .all(...[ftsQuery(q), ...(topic ? [topic] : []), Math.max(limit, 10)]);
    for (const r of rows) {
      const e = toNote(r, store);
      const head = new Set(tokenize(e.title + ' ' + e.tags.join(' ')));
      const all_ = new Set([...head, ...tokenize(e.body)]);
      const matched = q.filter((t) => all_.has(t)).length;
      res.push({ e, score: -r.s, matched, coverage: matched / q.length, inTitle: q.some((t) => head.has(t)) });
    }
  }
  return res.sort((a, b) => b.score - a.score).slice(0, limit);
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let i = 0; for (const t of A) if (B.has(t)) i++;
  return A.size + B.size - i === 0 ? 0 : i / (A.size + B.size - i);
}

/** Dedupe: FTS finds a few candidates (O(log N)), Jaccard decides. */
export function findSimilar(store, title, body) {
  const t = [...tokenize(title), ...tokenize(body)];
  if (!t.length) return null;
  const rows = store.db.prepare('SELECT notes.* FROM fts JOIN notes ON notes.n = fts.rowid WHERE fts MATCH ? ORDER BY bm25(fts,3,3,1) LIMIT 8').all(ftsQuery([...new Set(t)]));
  let best = null, bs = 0;
  for (const r of rows) {
    const s = jaccard(t, [...tokenize(r.title), ...tokenize(r.body)]);
    if (s > bs) { best = r; bs = s; }
  }
  return bs >= 0.75 ? toNote(best, store) : null;
}

/** Importance for the index. Recency is bucketed per week so the index stays byte-stable (prompt-cache friendly). */
export function rank(e, now = Date.now()) {
  const weeks = Math.floor(Math.max(0, (now - Date.parse(e.updated || e.created || 0)) / 864e5) / 7);
  return (e.pinned ? 1000 : 0) + 10 / (1 + (weeks * 7) / 30) + 2 * Math.log2(1 + (e.hits || 0)) + (e.type === 'pref' || e.type === 'gotcha' ? 1 : 0);
}
const byRank = (a, b) => rank(b) - rank(a) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

export function topicCounts(all, { includeScoped = false } = {}) {
  const m = new Map();
  for (const s of stores(all)) for (const r of s.db.prepare(`SELECT topic, COUNT(*) c FROM notes ${includeScoped ? '' : "WHERE paths=''"} GROUP BY topic`).all()) m.set(r.topic, (m.get(r.topic) || 0) + r.c);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const count = (all, where) => stores(all).reduce((n, s) => n + s.db.prepare(`SELECT COUNT(*) c FROM notes ${where}`).get().c, 0);

/**
 * Adaptive index: flat titles while everything fits the budget; otherwise
 * pinned titles + topic overview + top-ranked titles. Path-scoped notes never appear here (they auto-load on file access).
 */
export function buildIndex(all, scriptPath, { budgetTokens = Number(process.env.LEAN_MEMORY_INDEX_TOKENS) || 500 } = {}) {
  const total = count(all, ''), scoped = count(all, "WHERE paths != ''");
  const head = `[memory] ${total} notes. Details: node "${scriptPath}" get <id> | search <query> [--topic t]. ` +
    `Save: node "${scriptPath}" add --type decision|fact|pref|gotcha --title "<=${LIMITS.title}ch" --body "<=${LIMITS.body}ch" [--tags a,b] [--topic t] [--paths globs] [--global]. ` +
    `Save only durable, non-obvious facts not derivable from code; reuse existing notes instead of duplicating.` +
    (scoped ? `\n${scoped} path-scoped notes load automatically when matching files are read/edited.` : '');
  let budget = budgetTokens * 4 - head.length;
  const line = (e) => `${shortId(e)} ${e.type[0]}${e.pinned ? '*' : ''} ${e.title}`;
  const fetch = (sql, ...p) => stores(all).flatMap((s) => s.db.prepare(sql).all(...p).map((r) => toNote(r, s)));

  const pinned = fetch("SELECT * FROM notes WHERE pinned=1 AND paths=''").sort(byRank);
  const lines = [];
  const take = (e) => { const l = line(e); if (budget - l.length - 1 < 40) return false; lines.push(l); budget -= l.length + 1; return true; };
  pinned.forEach(take);

  const unpinnedCount = total - scoped - pinned.length;
  let rest;
  if (unpinnedCount <= 300) rest = fetch("SELECT * FROM notes WHERE pinned=0 AND paths=''").sort(byRank);
  else rest = fetch("SELECT * FROM (SELECT * FROM notes WHERE pinned=0 AND paths='' ORDER BY updated DESC LIMIT 150) UNION SELECT * FROM (SELECT * FROM notes WHERE pinned=0 AND paths='' ORDER BY hits DESC LIMIT 150)").sort(byRank);

  const fitsAll = rest.length === unpinnedCount && rest.reduce((n, e) => n + line(e).length + 1, 0) <= budget - 40;
  let topicLine = '';
  if (!fitsAll) {
    const topics = topicCounts(all);
    let t = 'topics (search --topic <t>):';
    for (const [name, c] of topics) { const part = ` ${name}(${c})`; if (t.length + part.length > budget * 0.4) { t += ' …'; break; } t += part; }
    topicLine = t; budget -= t.length + 1;
  }
  let shown = 0;
  const body = [];
  for (const e of rest) { const l = line(e); if (budget - l.length - 1 < 40) break; body.push(l); budget -= l.length + 1; shown++; }
  const out = [head, ...lines, ...(topicLine ? [topicLine] : []), ...body];
  const more = unpinnedCount - shown;
  if (more > 0) out.push(`(+${more} more, use search)`);
  return out.join('\n');
}

// ---- path scoping ----
export function globToRegex(g) {
  g = g.trim().replace(/^\.?\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

export function pathNotes(all, relPath) {
  const out = [];
  for (const s of stores(all)) {
    for (const r of s.db.prepare("SELECT * FROM notes WHERE paths != ''").all()) {
      const e = toNote(r, s);
      if (e.paths.some((p) => globToRegex(p).test(relPath))) out.push(e);
    }
  }
  return out.sort(byRank);
}

// ---- per-session "already injected" list shared by all hooks ----
const seenFile = (sid) => path.join(os.tmpdir(), `lean-memory-${String(sid || 'x').replace(/\W/g, '')}.json`);
export function seenLoad(sid) { try { return JSON.parse(fs.readFileSync(seenFile(sid), 'utf8')); } catch { return []; } }
export function seenAdd(sid, ids) { try { fs.writeFileSync(seenFile(sid), JSON.stringify([...new Set([...seenLoad(sid), ...ids])])); } catch { /* best effort */ } }

export async function readStdinJson() {
  try { return JSON.parse(await new Promise((r) => { let s = ''; process.stdin.on('data', (c) => (s += c)); process.stdin.on('end', () => r(s || '{}')); })); } catch { return {}; }
}

export const bootstrapHint = (scriptPath) =>
  `[memory] No notes for this repo yet. CLI: node "${scriptPath}". After finishing the user's first request, bootstrap the memory once: ` +
  `invoke the lean-memory:bootstrap skill (bounded: ~10 reads, <=25 notes; skip if the repo is trivial/empty), then remind the user to commit .claude/memory/notes.jsonl.`;
