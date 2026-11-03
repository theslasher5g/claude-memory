#!/usr/bin/env node
// lean-memory CLI. Output is deliberately terse: every byte printed costs tokens.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, TYPES, estTokens, loadAll, save, search, findById, findSimilar, newId, buildIndex, shortId, rank } from './lib.mjs';

const SELF = fileURLToPath(import.meta.url);
const BOOL = new Set(['pin', 'unpin', 'global', 'apply', 'full']);

function parse(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (BOOL.has(k)) flags[k] = true; else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { flags, pos };
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const die = (m) => { console.error(m); process.exit(1); };
const bucket = (all, e) => (e.scope === 'global' ? all.global : all.project);
const persist = (all) => { save(all.d.project, all.project); save(all.d.global, all.global); };

function cmdAdd(all, f) {
  const type = f.type || 'fact', title = clean(f.title), body = clean(f.body);
  if (!TYPES.includes(type)) die(`type must be one of ${TYPES.join('|')}`);
  if (!title) die('--title required');
  if (title.length > LIMITS.title) die(`title ${title.length}ch > ${LIMITS.title}; condense`);
  if (body.length > LIMITS.body) die(`body ${body.length}ch > ${LIMITS.body}; condense or split into atomic notes`);
  const scope = f.global ? 'global' : 'project';
  const list = all[scope];
  const now = new Date().toISOString();
  const tags = clean(f.tags).split(/[ ,]+/).filter(Boolean);
  const target = f.supersede ? findById(all, f.supersede) : findSimilar(list, title, body);
  if (target) {
    Object.assign(target, { type, title, body, tags: tags.length ? tags : target.tags, updated: now, pinned: f.pin ? true : target.pinned });
    persist(all);
    return `updated ${shortId(target)}`;
  }
  const e = { id: newId(list), type, title, body, tags, created: now, updated: now, hits: 0, pinned: !!f.pin, scope };
  list.push(e); persist(all);
  return `saved ${shortId(e)}`;
}

function fmt(e, full) {
  const head = `${shortId(e)} [${e.type}] ${e.title}`;
  if (full) return `${head}\n${e.body}${e.tags?.length ? `\n#${e.tags.join(' #')}` : ''}`;
  return e.body ? `${head} — ${e.body.length > 140 ? e.body.slice(0, 137) + '...' : e.body}` : head;
}

function run(cmd, pos, f) {
  const all = loadAll(process.cwd());
  const everything = () => [...all.project, ...all.global];
  switch (cmd) {
    case 'add': return cmdAdd(all, f);
    case 'search': {
      const res = search(everything(), pos.join(' '), { limit: Number(f.limit) || 5 });
      if (!res.length) return 'no match';
      res.forEach((r) => { r.e.hits = (r.e.hits || 0) + 1; }); persist(all);
      return res.map((r) => fmt(r.e, f.full)).join('\n');
    }
    case 'get': {
      if (!pos.length) die('usage: get <id...>');
      const out = pos.map((id) => { const e = findById(all, id); if (e) e.hits = (e.hits || 0) + 1; return e ? fmt(e, true) : `${id}: not found`; });
      persist(all); return out.join('\n');
    }
    case 'list': {
      const es = everything().filter((e) => !f.type || e.type === f.type).sort((a, b) => rank(b) - rank(a));
      return es.length ? es.map((e) => fmt(e, false)).join('\n') : 'empty';
    }
    case 'forget': {
      if (!pos.length) die('usage: forget <id...>');
      return pos.map((id) => {
        const e = findById(all, id); if (!e) return `${id}: not found`;
        const b = bucket(all, e); b.splice(b.indexOf(e), 1); return `forgot ${id}`;
      }).join('\n') + (persist(all), '');
    }
    case 'pin': case 'unpin': {
      return pos.map((id) => { const e = findById(all, id); if (!e) return `${id}: not found`; e.pinned = cmd === 'pin'; return `${cmd}ned ${id}`; }).join('\n') + (persist(all), '');
    }
    case 'index': return buildIndex(all, SELF);
    case 'stats': {
      const idx = buildIndex(all, SELF);
      return `project ${all.project.length}, global ${all.global.length}; session-start cost ≈ ${estTokens(idx)} tokens\n${all.d.project}\n${all.d.global}`;
    }
    case 'prune': {
      const days = Number(f.days) || 90, cutoff = Date.now() - days * 864e5;
      const stale = everything().filter((e) => !e.pinned && !(e.hits > 0) && Date.parse(e.updated || e.created) < cutoff);
      if (!f.apply) return stale.length ? `would remove ${stale.length} (unused, >${days}d, unpinned; add --apply):\n` + stale.map((e) => fmt(e)).join('\n') : 'nothing to prune';
      stale.forEach((e) => { const b = bucket(all, e); b.splice(b.indexOf(e), 1); });
      persist(all); return `removed ${stale.length}`;
    }
    default:
      return 'usage: add|search|get|list|forget|pin|unpin|index|stats|prune\n  add --type T --title "" --body "" [--tags a,b] [--global] [--pin] [--supersede id]\n  search <query> [--limit N] [--full]\n  get <id...> | forget <id...> | prune [--days N] [--apply]';
  }
}

const { flags, pos } = parse(process.argv.slice(2));
const cmd = pos.shift();
console.log(run(cmd, pos, flags));
