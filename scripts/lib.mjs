// Shared helpers for building / refreshing the static news archive.
// Node >= 18 (global fetch). No secrets needed: the worker URL is public.
import fs from 'node:fs';
import path from 'node:path';

export const WORKER_URL = process.env.WORKER_URL || 'https://cf-news-worker.amosxch.workers.dev';
export const DOMAINS = ['ai', 'policy', 'energy'];
export const TZ = 'Asia/Shanghai';

export function todayCst(now = Date.now()) {
  return new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
}
export function nowCstIso(now = Date.now()) {
  return new Date(now + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00';
}
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  const p = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 86400000);
}
export const monthOf = (ymd) => ymd.slice(0, 7);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function chunks(start, end, size) {
  const out = [];
  for (let s = start; s <= end; s = addDays(s, size)) {
    const e = addDays(s, size - 1);
    out.push([s, e > end ? end : e]);
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normalise a worker item to the static-site schema. Worker importance 1-3 -> site scale (3 => 2, else 0). */
export function normWorkerItem(it, domain) {
  return {
    domain,
    title: String(it.title || '').trim(),
    summary: String(it.summary || '').trim(),
    date: it.date,
    url: it.url,
    source: it.source,
    sentiment: ['利好', '利空', '中性'].includes(it.sentiment) ? it.sentiment : '中性',
    analysis: String(it.analysis || '').trim(),
    importance: Number(it.importance) >= 3 ? 2 : 0,
    live: false,
  };
}

export function validItem(it, start, end, today) {
  return (
    it && it.title && /^https?:\/\//.test(it.url || '') && DATE_RE.test(it.date || '') &&
    it.date >= start && it.date <= end && it.date <= today && DOMAINS.includes(it.domain)
  );
}

/** Fetch one (domain, range) from the worker with retries. Returns {items, sources, meta, attempts, ok}. */
export async function fetchChunk(domain, start, end, { limit = 10, deep = true, store0 = true, storeMode = null, retries = 2, timeoutMs = 150000, log = () => {} } = {}) {
  const today = todayCst();
  let last = null;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const url = `${WORKER_URL}/api/news?start=${start}&end=${end}&domains=${domain}&limit=${limit}&fresh=1${storeMode ? '&store=' + storeMode : store0 ? '&store=0' : ''}${deep ? '&deep=1' : ''}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'multi-news-digest-refresh/1.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const meta = (j.domain_meta || {})[domain] || {};
      const liveOnly = (j.items || []).filter((it) => it.live !== false); // worker pads thin results with the site's own news.json: ignore those
      const items = liveOnly.map((it) => normWorkerItem(it, domain)).filter((it) => validItem(it, start, end, today));
      const srcBad = (j.sources || []).filter((s) => s.status !== 'ok' && s.status !== 'blocked' && s.status !== 'cached');
      const llmOk = !!(meta.llm && meta.llm.analyzed) || liveOnly.length === 0 || meta.candidates === 0;
      last = { ok: llmOk && srcBad.length === 0, items, sources: j.sources || [], meta, attempts: attempt, dropped: liveOnly.length - items.length, elapsed_ms: j.elapsed_ms };
      if (last.ok) return last;
      log(`  retry ${domain} ${start}..${end}: llm=${llmOk} badSources=${srcBad.map((s) => s.id + ':' + s.status).join(',')}`);
    } catch (e) {
      last = { ok: false, items: [], sources: [], meta: {}, attempts: attempt, error: String(e && e.message ? e.message : e) };
      log(`  error ${domain} ${start}..${end}: ${last.error}`);
    } finally {
      clearTimeout(t);
    }
    await sleep(1500 * attempt);
  }
  return last;
}

// ---------- archive files ----------
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 1) + '\n');
}

export function loadArchive(dataDir) {
  const dir = path.join(dataDir, 'archive');
  const months = {};
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(\d{4}-\d{2})\.json$/);
      if (m) months[m[1]] = (readJson(path.join(dir, f), { items: [] }).items) || [];
    }
  }
  return months;
}

const CAP_PER_DOMAIN_DAY = 6; // non-curated items kept per domain per day (keeps refreshes from bloating)

/**
 * Merge `incoming` into `existing` (both arrays of items).
 * - curated items (from data/news.json) always win on URL clash and are exempt from the per-day cap
 * - existing worker items are stable: new items only fill free slots or outrank lower-importance ones
 */
export function mergeItems(existing, incoming, curatedUrls = new Set()) {
  const byUrl = new Map();
  for (const it of existing) byUrl.set(it.url, it);
  let added = 0;
  for (const it of incoming) {
    if (!byUrl.has(it.url)) { byUrl.set(it.url, it); added++; }
    else if (curatedUrls.has(it.url)) byUrl.set(it.url, it);
  }
  const all = [...byUrl.values()];
  const groups = new Map();
  const keep = [];
  for (const it of all) {
    if (curatedUrls.has(it.url)) { keep.push(it); continue; }
    const k = it.domain + '|' + it.date;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const exSet = new Set(existing.map((x) => x.url));
  for (const list of groups.values()) {
    list.sort((a, b) => (b.importance || 0) - (a.importance || 0) || (exSet.has(b.url) ? 1 : 0) - (exSet.has(a.url) ? 1 : 0));
    keep.push(...list.slice(0, CAP_PER_DOMAIN_DAY));
  }
  keep.sort((a, b) => b.date.localeCompare(a.date) || a.domain.localeCompare(b.domain) || (b.importance || 0) - (a.importance || 0) || a.url.localeCompare(b.url));
  return { items: keep, added };
}

export function stableItemsKey(items) {
  return items.map((x) => [x.url, x.title, x.summary, x.sentiment, x.analysis, x.importance].join('\u0001')).join('\n');
}

export function buildIndex(months, prev, { changed, now = Date.now(), notes } = {}) {
  const list = Object.keys(months).sort().map((m) => {
    const counts = { ai: 0, policy: 0, energy: 0 };
    for (const it of months[m]) counts[it.domain] = (counts[it.domain] || 0) + 1;
    return { month: m, file: `archive/${m}.json`, count: months[m].length, counts };
  });
  const dates = Object.values(months).flat().map((x) => x.date).sort();
  const prevCov = (prev && prev.coverage) || {};
  const today = todayCst(now);
  return {
    version: 1,
    updated_at: changed || !prev ? nowCstIso(now) : prev.updated_at,
    checked_at: nowCstIso(now),
    timezone: TZ,
    coverage: { start: prevCov.start || dates[0] || today, end: prevCov.end || today },
    months: list,
    ...(notes ? { notes } : prev && prev.notes ? { notes: prev.notes } : {}),
  };
}
