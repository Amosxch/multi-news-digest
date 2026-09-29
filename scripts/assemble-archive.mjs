// Assemble raw worker chunks (from build-archive.mjs) + curated data/news.json into data/archive/YYYY-MM.json and data/index.json.
// node scripts/assemble-archive.mjs [--raw /workspace/archive-raw] [--data ./data]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS, readJson, writeJson, monthOf, mergeItems, buildIndex, loadArchive, todayCst } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(args.data || path.join(root, 'data'));
const raw = path.resolve(args.raw || '/workspace/archive-raw');

const curated = (readJson(path.join(dataDir, 'news.json'), { items: [] }).items || []).map((x) => ({ ...x, live: false }));
const curatedUrls = new Set(curated.map((x) => x.url));
const months = loadArchive(dataDir);

const gaps = [];
let rawItems = 0;
const chunkDefs = fs.readdirSync(raw).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(raw, f)));
const incoming = [];
for (const c of chunkDefs) {
  if (!c) continue;
  rawItems += (c.items || []).length;
  incoming.push(...(c.items || []));
  const bad = (c.sources || []).filter((s) => s.status !== 'ok' && s.status !== 'blocked' && s.status !== 'cached');
  if (!c.ok || bad.length) gaps.push({ domain: c.domain, start: c.start, end: c.end, ok: !!c.ok, error: c.error || undefined, sources: bad.map((s) => `${s.id}:${s.status}:${(s.error || '').slice(0, 80)}`) });
}
// group by month
const inByMonth = {};
for (const it of [...incoming, ...curated]) (inByMonth[monthOf(it.date)] ||= []).push(it);
let added = 0;
for (const [m, list] of Object.entries(inByMonth)) {
  // curated first so they win URL clashes
  const r = mergeItems(months[m] || [], list.sort((a, b) => (curatedUrls.has(b.url) ? 1 : 0) - (curatedUrls.has(a.url) ? 1 : 0)), curatedUrls);
  months[m] = r.items;
  added += r.added;
}
for (const [m, items] of Object.entries(months)) writeJson(path.join(dataDir, 'archive', `${m}.json`), { month: m, items });

// per-source gap accounting (which source produced how many items per month)
const perSource = {};
for (const [m, items] of Object.entries(months)) for (const it of items) { const k = `${it.domain}|${it.source}`; (perSource[k] ||= {})[m] = (perSource[k][m] || 0) + 1; }
const start = Object.keys(months).sort()[0] + '-01';
const idx = buildIndex(months, null, { changed: true, notes: { archive_start: args.start || '2026-01-01' } });
idx.coverage = { start: args.start || '2026-01-01', end: args.end || todayCst() };
writeJson(path.join(dataDir, 'index.json'), idx);
writeJson(path.join(dataDir, 'archive-report.json'), { generated_at: new Date().toISOString(), raw_chunks: chunkDefs.length, raw_items: rawItems, gaps, per_source_by_month: perSource });
console.log(`months=${Object.keys(months).length} rawItems=${rawItems} gaps=${gaps.length}`);
for (const m of idx.months) console.log(m.month, m.count, JSON.stringify(m.counts));
