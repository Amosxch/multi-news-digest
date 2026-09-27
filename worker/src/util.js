// Shared helpers: dates (Asia/Shanghai), fetch with timeout + subrequest budget, HTML helpers.

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const TZ_OFFSET_MS = 8 * 3600 * 1000; // Asia/Shanghai, no DST

/** 'YYYY-MM-DD' -> integer day number (days since 1970-01-01 in CST). */
export function dayNum(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
export function dayStr(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}
/** epoch ms -> 'YYYY-MM-DD' in CST */
export function msToYmd(ms) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
}
export function todayCst() {
  return msToYmd(Date.now());
}
/** Normalise many date spellings to YYYY-MM-DD (or null). */
export function normDate(s) {
  if (!s) return null;
  const m = String(s).match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}
export function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}
export function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}
export function absUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * Per-invocation context: shared subrequest budget + deadline.
 * Cloudflare Free plan allows 50 subrequests per invocation (Paid: far more);
 * we keep a configurable budget and refuse fetches beyond it.
 */
export class Ctx {
  constructor({ budget = 45, deadlineMs = 22000, fetchTimeoutMs = 9000, log = false } = {}) {
    this.budget = budget;
    this.used = 0;
    this.deadline = Date.now() + deadlineMs;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.log = log;
  }
  remaining() {
    return this.budget - this.used;
  }
  timeLeft() {
    return this.deadline - Date.now();
  }
  /** Carve out a child budget for one source so one slow site cannot starve others. */
  child(budget) {
    const c = Object.create(this);
    c.parent = this;
    c.budget = budget;
    c.used = 0;
    return c;
  }
  take() {
    if (this.used >= this.budget) throw new BudgetError(this.parent ? 'source subrequest budget exhausted' : 'subrequest budget exhausted');
    if (this.parent) this.parent.take();
    this.used++;
  }
}
export class BudgetError extends Error {}

export async function fetchText(ctx, url, init = {}) {
  ctx.take();
  const left = ctx.timeLeft();
  if (left < 800) throw new Error('deadline reached');
  const timeout = Math.min(ctx.fetchTimeoutMs, left);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort('timeout'), timeout);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/json,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        ...(init.headers || {}),
      },
      signal: ac.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    if (ctx.log) console.log(`[fetch] ${res.status} ${Date.now() - started}ms ${text.length}B ${url}`);
    return { status: res.status, ok: res.ok, text, headers: res.headers };
  } catch (e) {
    if (ctx.log) console.log(`[fetch] ERR ${Date.now() - started}ms ${url} ${e}`);
    throw new Error(`fetch failed (${String(e && e.message ? e.message : e).slice(0, 80)}): ${url}`);
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson(ctx, url, init) {
  const r = await fetchText(ctx, url, init);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  try {
    return JSON.parse(r.text);
  } catch {
    throw new Error(`invalid JSON from ${url}`);
  }
}

/** Detect common anti-bot interstitials so we can report them honestly. */
export function detectBlock(text, status) {
  if (status === 403) return 'HTTP 403 (anti-bot/WAF)';
  if (/aliyun_waf|acw_sc__v2|renderData"[^>]*>\{"l1"/.test(text)) return 'Aliyun WAF JS challenge';
  if (/cf-browser-verification|challenge-platform/.test(text)) return 'Cloudflare challenge';
  return null;
}

export function inRange(date, start, end) {
  return !!date && date >= start && date <= end;
}

/**
 * Generic "random-access paged list, newest first" search.
 * fetchPage(i) -> Promise<Array<{date,...}>> (empty array => past the end).
 * Finds the pages that overlap [start,end] with interpolation search, then fetches
 * all of them or an evenly spaced sample (limited by maxRangePages).
 * Returns { items, pagesFetched, note }.
 */
export async function pagedSearch({ fetchPage, start, end, maxProbes = 6, maxRangePages = 4, maxPage = 100000, initialDpp = null }) {
  const S = dayNum(start);
  const E = dayNum(end);
  const pages = new Map(); // i -> {items,newest,oldest} | {empty:true}
  let probes = 0;
  const get = async (i) => {
    if (pages.has(i)) return pages.get(i);
    const items = (await fetchPage(i)) || [];
    const ds = items.map((x) => x.date && dayNum(x.date)).filter((x) => Number.isFinite(x));
    const rec = ds.length ? { items, newest: Math.max(...ds), oldest: Math.min(...ds) } : { items, empty: true };
    pages.set(i, rec);
    return rec;
  };
  const p0 = await get(0);
  if (p0.empty) throw new Error('first list page returned no dated items');
  const out = () => {
    const all = [];
    for (const [, rec] of pages) for (const it of rec.items) if (inRange(it.date, start, end)) all.push(it);
    return all;
  };
  if (p0.newest < S) return { items: [], pagesFetched: pages.size, note: `newest item ${dayStr(p0.newest)} is before range` };

  // days per page estimate from known pages
  const dpp = () => {
    let best = null;
    for (const [i, rec] of pages) if (!rec.empty && i > 0 && (best === null || i > best)) best = i;
    if (best === null) return initialDpp || Math.max(0.05, p0.newest - p0.oldest + 0.5);
    return Math.max(0.001, (p0.newest - pages.get(best).oldest) / (best + 1));
  };
  // first page index whose oldest item <= X
  const locate = async (X) => {
    if (p0.oldest <= X) return 0;
    let lo = 0; // page known to be entirely newer than X
    let hi = null; // page known to reach X (oldest<=X) or be empty (past end)
    for (const [i, rec] of pages) {
      if (rec.empty) { if (hi === null || i < hi) hi = i; continue; }
      if (rec.oldest > X) { if (i > lo) lo = i; } else if (hi === null || i < hi) hi = i;
    }
    while ((hi === null || hi - lo > 1) && probes < maxProbes) {
      const loRec = pages.get(lo);
      let g;
      if (hi === null || pages.get(hi).empty) {
        g = lo + Math.max(1, Math.round((loRec.oldest - X) / dpp()));
        if (hi !== null) g = Math.min(g, hi - 1);
      } else {
        const hiRec = pages.get(hi);
        const span = loRec.oldest - hiRec.oldest || 1;
        g = lo + Math.round(((loRec.oldest - X) / span) * (hi - lo));
      }
      g = Math.min(Math.max(g, lo + 1), hi === null ? maxPage : hi - 1);
      if (g > maxPage) break;
      probes++;
      const rec = await get(g);
      if (rec.empty) hi = g;
      else if (rec.oldest > X) lo = g;
      else hi = g;
    }
    if (hi === null) return lo + 1;
    if (pages.get(hi) && pages.get(hi).empty) return Math.max(lo, hi - 1);
    return hi;
  };
  const pEnd = await locate(E);
  const pStart = await locate(S - 1);
  let want = [];
  for (let i = pEnd; i <= pStart; i++) if (!pages.has(i)) want.push(i);
  let note = `pages ${pEnd}..${pStart}`;
  if (want.length > maxRangePages) {
    const n = maxRangePages;
    const picked = new Set();
    for (let k = 0; k < n; k++) picked.add(want[Math.round((k * (want.length - 1)) / Math.max(1, n - 1))]);
    note += `, sampled ${picked.size}/${want.length} unfetched`;
    want = [...picked];
  }
  await Promise.allSettled(want.map((i) => get(i)));
  return { items: out(), pagesFetched: pages.size, note };
}
