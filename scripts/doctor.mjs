// `mem.mjs doctor`: read-only health check. Finds stale, duplicated and unused notes so they can be fixed or consolidated.
import { spawnSync } from 'node:child_process';
import { stores, tokenize, globToRegex, shortId, estTokens, buildIndex } from './lib.mjs';

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const PATH_RE = /(?:^|[\s`'"(\[])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w]{0,5}|[\w-]+\.(?:rs|ts|tsx|js|mjs|py|go|java|kt|rb|php|c|h|cpp|toml|json|ya?ml|md|sh|sql|lock))(?=$|[\s`'"),.:;\]])/g;

function gitFiles(root) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b); let i = 0; for (const t of A) if (B.has(t)) i++;
  return A.size + B.size - i ? i / (A.size + B.size - i) : 0;
}

export function doctor(all, root, { days = 90, maxTopic = 12, scriptPath = '' } = {}) {
  const notes = stores(all).flatMap((s) => s.db.prepare('SELECT * FROM notes').all().map((r) => ({
    ...r, scope: s.scope, tags: r.tags ? r.tags.split(',') : [], paths: r.paths ? r.paths.split(',') : [],
  })));
  const id = (n) => (n.scope === 'global' ? 'g-' : '') + n.id;
  const files = gitFiles(root);
  const findings = [];

  if (files) {
    const set = new Set(files);
    const bySuffix = (ref) => set.has(ref) || files.some((f) => f.endsWith('/' + ref));
    for (const n of notes) {
      if (n.scope === 'global') continue;
      for (const g of n.paths) {
        const re = globToRegex(g);
        const stat = g.replace(/^\.?\//, '').split(/[*?]/)[0];
        if (!files.some((f) => re.test(f)) && !(stat && files.some((f) => f.startsWith(stat)))) findings.push(['STALE-PATH', id(n), `path "${g}" matches no file — ${clip(n.title, 60)}`]);
      }
      const text = `${n.title} ${n.body}`;
      const refs = new Set(); let m; PATH_RE.lastIndex = 0;
      while ((m = PATH_RE.exec(text))) refs.add(m[1]);
      for (const ref of refs) if (!/\*/.test(ref) && !bySuffix(ref)) findings.push(['MISSING-FILE', id(n), `mentions ${ref}, not found in the repo — ${clip(n.title, 50)}`]);
    }
  } else findings.push(['INFO', '-', 'not a git repo: path and file checks skipped']);

  // near-duplicates (below the 0.75 auto-merge threshold of `add`)
  const toks = new Map(notes.map((n) => [n, [...tokenize(n.title), ...tokenize(n.body)]]));
  const byTok = new Map();
  for (const [n, t] of toks) for (const w of new Set(t)) { if (!byTok.has(w)) byTok.set(w, []); byTok.get(w).push(n); }
  const seenPair = new Set();
  for (const [n, t] of toks) {
    const cand = new Map();
    for (const w of new Set(t)) { const l = byTok.get(w); if (l.length > 40) continue; for (const o of l) if (o !== n) cand.set(o, (cand.get(o) || 0) + 1); }
    for (const [o, shared] of cand) {
      if (shared < 3 || o.scope !== n.scope) continue;
      const key = [n.id, o.id].sort().join('|'); if (seenPair.has(key)) continue; seenPair.add(key);
      const j = jaccard(t, toks.get(o));
      if (j >= 0.45) findings.push(['DUPLICATE?', `${id(n)} ${id(o)}`, `${Math.round(j * 100)}% overlap — "${clip(n.title, 40)}" / "${clip(o.title, 40)}" (merge them)`]);
    }
  }

  // old and never fetched (hit counters are local to this clone, so this is a hint, not proof)
  const cutoff = Date.now() - days * 864e5;
  for (const n of notes) if (!n.pinned && !n.hits && Date.parse(n.updated || n.created) < cutoff) findings.push(['UNUSED', id(n), `not fetched here and untouched for ${days}+ days — ${clip(n.title, 60)}`]);

  // topics that are worth consolidating
  const perTopic = new Map(); for (const n of notes) perTopic.set(n.topic, (perTopic.get(n.topic) || 0) + 1);
  for (const [t, c] of [...perTopic].sort((a, b) => b[1] - a[1])) if (c > maxTopic) findings.push(['CONSOLIDATE', t, `${c} notes in topic "${t}" — run /lean-memory:consolidate ${t}`]);

  const idx = estTokens(buildIndex(all, scriptPath || 'mem.mjs'));
  const head = `${notes.length} notes (${notes.filter((n) => n.paths.length).length} path-scoped, ${notes.filter((n) => n.pinned).length} pinned), session-start cost ≈ ${idx} tokens, ${findings.filter((f) => f[0] !== 'INFO').length} finding(s)`;
  return { head, findings };
}
