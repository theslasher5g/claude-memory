#!/usr/bin/env node
// lean-memory CLI. Output is deliberately terse: every byte printed costs tokens.
import { fileURLToPath } from 'node:url';
import {
  LIMITS, TYPES, estTokens, openAll, stores, search, findSimilar, newId, buildIndex, shortId, rank,
  insert, update, remove, getById, bumpHits, resolve, topicCounts, write,
} from './lib.mjs';

const SELF = fileURLToPath(import.meta.url);
const BOOL = new Set(['pin', 'global', 'apply', 'full']);

function parse(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); flags[k] = BOOL.has(k) ? true : argv[++i]; } else pos.push(a);
  }
  return { flags, pos };
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const list = (s) => clean(s).split(/[ ,]+/).filter(Boolean);
const die = (m) => { console.error(m); process.exit(1); };

function fmt(e, full) {
  const head = `${shortId(e)} [${e.type}] ${e.title}`;
  if (full) return `${head}\n${e.body}${e.tags.length ? `\n#${e.tags.join(' #')}` : ''}${e.paths.length ? `\npaths: ${e.paths.join(', ')}` : ''}`;
  return e.body ? `${head} — ${e.body.length > 140 ? e.body.slice(0, 137) + '...' : e.body}` : head;
}

function cmdAdd(all, f) {
  const type = f.type || 'fact', title = clean(f.title), body = clean(f.body);
  if (!TYPES.includes(type)) die(`type must be one of ${TYPES.join('|')}`);
  if (!title) die('--title required');
  if (title.length > LIMITS.title) die(`title ${title.length}ch > ${LIMITS.title}; condense`);
  if (body.length > LIMITS.body) die(`body ${body.length}ch > ${LIMITS.body}; condense or split into atomic notes`);
  const store = f.global ? all.global : all.project;
  const tags = list(f.tags), paths = clean(f.paths).split(',').map((s) => s.trim()).filter(Boolean);
  const topic = f.topic ? clean(f.topic).toLowerCase() : undefined;
  const target = f.supersede ? resolve(all, f.supersede) : (() => { const e = findSimilar(store, title, body); return e && { store, e }; })();
  if (target) {
    const patch = { type, title, body, tags: tags.length ? tags : target.e.tags, paths: paths.length ? paths : target.e.paths, pinned: f.pin ? true : target.e.pinned };
    if (topic) patch.topic = topic;
    write(target.store, () => update(target.store, target.e.id, patch));
    return `updated ${shortId(target.e)}`;
  }
  const e = { id: newId(store), type, title, body, tags, topic, paths, pinned: !!f.pin, scope: store.scope };
  write(store, () => insert(store, e));
  return `saved ${shortId(e)}`;
}

function every(all, sql, params = []) {
  return stores(all).flatMap((s) => s.db.prepare(sql).all(...params).map((r) => getById(s, r.id)));
}

function run(cmd, pos, f) {
  const all = openAll(process.cwd(), { create: cmd === 'add' });
  if (cmd === 'add') {
    return cmdAdd(all, f);
  }
  if (!stores(all).length && !['index', 'stats', 'topics', 'list', 'search', undefined].includes(cmd)) return 'empty';
  switch (cmd) {
    case 'search': {
      const res = search(all, pos.join(' '), { limit: Number(f.limit) || 5, topic: f.topic });
      return res.length ? res.map((r) => fmt(r.e, f.full)).join('\n') : 'no match';
    }
    case 'get': {
      if (!pos.length) die('usage: get <id...>');
      return pos.map((ref) => {
        const t = resolve(all, ref); if (!t) return `${ref}: not found`;
        bumpHits(t.store, t.e.id); return fmt(t.e, true);
      }).join('\n');
    }
    case 'list': {
      const es = every(all, f.topic ? 'SELECT id FROM notes WHERE topic=?' : 'SELECT id FROM notes', f.topic ? [f.topic] : [])
        .filter((e) => !f.type || e.type === f.type).sort((a, b) => rank(b) - rank(a)).slice(0, Number(f.limit) || 50);
      return es.length ? es.map((e) => fmt(e, false)).join('\n') : 'empty';
    }
    case 'topics': { const t = topicCounts(all); return t.length ? t.map(([n, c]) => `${n}(${c})`).join(' ') : 'empty'; }
    case 'forget': {
      if (!pos.length) die('usage: forget <id...>');
      return pos.map((ref) => { const t = resolve(all, ref); if (!t) return `${ref}: not found`; write(t.store, () => remove(t.store, t.e.id)); return `forgot ${ref}`; }).join('\n');
    }
    case 'pin': case 'unpin': {
      return pos.map((ref) => {
        const t = resolve(all, ref); if (!t) return `${ref}: not found`;
        write(t.store, () => update(t.store, t.e.id, { pinned: cmd === 'pin' })); return `${cmd}ned ${ref}`;
      }).join('\n');
    }
    case 'index': return buildIndex(all, SELF);
    case 'stats': {
      const n = (s) => (s ? s.db.prepare('SELECT COUNT(*) c FROM notes').get().c : 0);
      const sc = stores(all).reduce((a, s) => a + s.db.prepare("SELECT COUNT(*) c FROM notes WHERE paths!=''").get().c, 0);
      return `project ${n(all.project)}, global ${n(all.global)} (${sc} path-scoped); session-start cost ≈ ${estTokens(buildIndex(all, SELF))} tokens\n${all.d.project}\n${all.d.global}`;
    }
    case 'prune': {
      const days = Number(f.days) || 90, cutoff = new Date(Date.now() - days * 864e5).toISOString();
      const stale = [];
      for (const s of stores(all)) for (const r of s.db.prepare('SELECT id FROM notes WHERE pinned=0 AND hits=0 AND updated<?').all(cutoff)) stale.push({ s, e: getById(s, r.id) });
      if (!f.apply) return stale.length ? `would remove ${stale.length} (unused, >${days}d, unpinned; add --apply):\n` + stale.map((x) => fmt(x.e)).join('\n') : 'nothing to prune';
      for (const { s, e } of stale) write(s, () => remove(s, e.id));
      return `removed ${stale.length}`;
    }
    default:
      return 'usage: add|search|get|list|topics|forget|pin|unpin|index|stats|prune\n' +
        '  add --type T --title "" --body "" [--tags a,b] [--topic t] [--paths "src/x/**,docs/y.md"] [--global] [--pin] [--supersede id]\n' +
        '  search <query> [--topic t] [--limit N] [--full] | get <id...> | list [--topic t] [--type T]\n  forget <id...> | prune [--days N] [--apply]';
  }
}

const { flags, pos } = parse(process.argv.slice(2));
const cmd = pos.shift();
console.log(run(cmd, pos, flags));
