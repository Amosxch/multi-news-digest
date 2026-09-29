// Scheduled refresh: pull the last N days from the (public) news worker, merge into data/archive/<month>.json + data/index.json.
// node scripts/refresh.mjs [--days 3] [--data ./data] [--dry] [--limit 10]
// Exit code 0 even when nothing changed. Exits non-zero only when *every* chunk failed (so the workflow shows a red run).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOMAINS, addDays, todayCst, fetchChunk, readJson, writeJson, loadArchive, mergeItems, buildIndex, monthOf, stableItemsKey, WORKER_URL } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), x.startsWith('--dry') ? '1' : arr[i + 1]]] : a), []));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(args.data || path.join(root, 'data'));
const days = Number(args.days || 3);
const limit = Number(args.limit || 10);
const dry = !!args.dry;

const today = todayCst();
const start = addDays(today, -(days - 1));
console.log(`refresh ${start}..${today} worker=${WORKER_URL} data=${dataDir}${dry ? ' (dry run)' : ''}`);

const curated = (readJson(path.join(dataDir, 'news.json'), { items: [] }).items || []).map((x) => ({ ...x, live: false }));
const curatedUrls = new Set(curated.map((x) => x.url));
const months = loadArchive(dataDir);
const before = Object.fromEntries(Object.entries(months).map(([m, l]) => [m, stableItemsKey(l)]));
const prevIndex = readJson(path.join(dataDir, 'index.json'), null);

const results = await Promise.all(
  DOMAINS.map((d) => fetchChunk(d, start, today, { limit, deep: false, store0: false, storeMode: 'pool', retries: 2, timeoutMs: 120000, log: (m) => console.log(m) }))
);
let okCount = 0;
const incoming = [];
results.forEach((r, i) => {
  const d = DOMAINS[i];
  const bad = (r.sources || []).filter((s) => s.status !== 'ok' && s.status !== 'blocked' && s.status !== 'cached').map((s) => `${s.id}:${s.status}`);
  console.log(`${d}: items=${r.items.length} ok=${r.ok} attempts=${r.attempts}${r.error ? ' error=' + r.error : ''}${bad.length ? ' badSources=' + bad.join(',') : ''} llm=${r.meta && r.meta.llm ? JSON.stringify(r.meta.llm) : '-'}`);
  if (r.items.length || r.ok) okCount++;
  // partial data is still useful (merge only adds), but skip when the LLM step failed: those items would have empty analysis
  if (r.meta && r.meta.llm && r.meta.llm.analyzed === false && r.items.length) { console.log(`  skip ${d}: LLM not analysed, not merging unanalysed items`); return; }
  incoming.push(...r.items);
});
if (okCount === 0) { console.error('every chunk failed'); process.exit(1); }

// curated items (data/news.json) always win
incoming.push(...curated.filter((x) => x.date >= addDays(today, -400)));
const inByMonth = {};
for (const it of incoming) (inByMonth[monthOf(it.date)] ||= []).push(it);
let added = 0;
let changedMonths = [];
for (const [m, list] of Object.entries(inByMonth)) {
  list.sort((a, b) => (curatedUrls.has(b.url) ? 1 : 0) - (curatedUrls.has(a.url) ? 1 : 0));
  const r = mergeItems(months[m] || [], list, curatedUrls);
  added += r.added;
  months[m] = r.items;
  if (stableItemsKey(r.items) !== (before[m] || '')) changedMonths.push(m);
}
const changed = changedMonths.length > 0;
const idx = buildIndex(months, prevIndex, { changed });
// coverage end = today (we just checked up to today)
idx.coverage = { start: (prevIndex && prevIndex.coverage && prevIndex.coverage.start) || idx.coverage.start, end: today };
const idxChanged = !prevIndex || JSON.stringify({ ...idx, checked_at: 0 }) !== JSON.stringify({ ...prevIndex, checked_at: 0 });
console.log(`added=${added} changedMonths=${changedMonths.join(',') || '-'} indexChanged=${idxChanged}`);

if (dry) { console.log('dry run: nothing written'); process.exit(0); }
for (const m of changedMonths) writeJson(path.join(dataDir, 'archive', `${m}.json`), { month: m, items: months[m] });
// checked_at is only written together with real changes so a no-op run leaves the git tree clean
if (changed || idxChanged) writeJson(path.join(dataDir, 'index.json'), idx);
console.log(changed || idxChanged ? 'written' : 'no changes');
