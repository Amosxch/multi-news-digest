import { SOURCES } from './sources/index.js';
import { Ctx, BudgetError, dayNum, dayStr, isYmd, todayCst } from './util.js';
import { selectCandidates } from './rank.js';
import { analyze } from './llm.js';
import { validateBody, gatherCustom, LIMITS as CUSTOM_LIMITS } from './custom.js';

const VERSION = 'v3';
const DOMAINS = ['ai', 'policy', 'energy'];
const BLOCKED = new Set(['bjx', 'inen', 'ggii']); // anti-bot / broken TLS from datacenter IPs

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || 'https://amosxch.github.io').split(',').map((s) => s.trim());
  const ok = allowed.includes('*') || allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin || allowed[0] : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
function json(req, env, body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(req, env), ...extra },
  });
}

async function kvGet(env, key) {
  if (!env.NEWS_KV) return null;
  try {
    return await env.NEWS_KV.get(key, 'json');
  } catch {
    return null;
  }
}
async function kvPut(env, key, val, ttl) {
  if (!env.NEWS_KV) return;
  try {
    await env.NEWS_KV.put(key, JSON.stringify(val), ttl ? { expirationTtl: Math.max(60, ttl) } : undefined);
  } catch (e) {
    console.log('kv put failed', key, String(e));
  }
}
async function sha1(s) {
  const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

const slim = (it) => ({ title: it.title, url: it.url, date: it.date, source: it.source, desc: (it.desc || '').slice(0, 120), pv: it.pv || 0 });

/** Fetch all sources of one domain (or read per-day raw cache). */
async function gatherDomain(env, ctx, domain, start, end, opts) {
  const today = todayCst();
  const days = [];
  for (let d = dayNum(start); d <= dayNum(end); d++) days.push(dayStr(d));

  // 1) per-day raw cache (only complete past days are ever written)
  if (!opts.fresh && env.NEWS_KV && days.length <= 62) {
    const cached = await Promise.all(days.map((d) => kvGet(env, `${VERSION}:day:${domain}:${d}`)));
    if (cached.every(Boolean)) {
      const items = cached.flatMap((c) => c.items);
      const statuses = SOURCES[domain].map((s) => ({ id: s.id, name: s.name, domain, status: 'cached', count: items.filter((x) => x.source === s.name || x.source.startsWith(s.name)).length }));
      return { items, statuses, fromCache: true };
    }
  }

  // 2) live fetch, all sources in parallel, each with its own sub-budget
  const list = SOURCES[domain];
  const active = list.filter((s) => opts.probe || !BLOCKED.has(s.id));
  const want = active.reduce((a, s) => a + s.budget, 0);
  const scale = opts.deep ? Math.min(3, ctx.remaining() / Math.max(1, want)) : Math.min(1, ctx.remaining() / Math.max(1, want));
  const statuses = [];
  const items = [];
  await Promise.all(
    list.map(async (s) => {
      const st = { id: s.id, name: s.name, domain, status: 'ok', count: 0, requests: 0, ms: 0 };
      statuses.push(st);
      if (!active.includes(s)) {
        st.status = 'blocked';
        st.note = '该站对数据中心/Worker 出口有反爬或证书问题，默认跳过（?probe=1 可强制尝试）';
        return;
      }
      const child = ctx.child(Math.max(1, Math.round(s.budget * scale)));
      const t0 = Date.now();
      try {
        const r = await s.fetch(child, start, end);
        const got = (r.items || []).filter((x) => x.date >= start && x.date <= end && x.date <= today);
        st.count = got.length;
        st.note = r.note;
        items.push(...got.map(slim));
      } catch (e) {
        st.status = e instanceof BudgetError ? 'partial' : 'error';
        st.error = String(e.message || e).slice(0, 200);
      } finally {
        st.requests = child.used;
        st.ms = Date.now() - t0;
      }
    })
  );
  statuses.sort((a, b) => list.findIndex((s) => s.id === a.id) - list.findIndex((s) => s.id === b.id));

  // 3) write per-day raw cache if every non-blocked source succeeded
  const healthy = statuses.every((s) => s.status === 'ok' || s.status === 'blocked');
  if (healthy && env.NEWS_KV && days.length <= 31) {
    const writes = days
      .filter((d) => d < today)
      .map((d) => kvPut(env, `${VERSION}:day:${domain}:${d}`, { items: items.filter((x) => x.date === d), at: new Date().toISOString() }, 60 * 86400));
    opts.waitUntil(Promise.all(writes));
  }
  return { items, statuses, fromCache: false };
}

let staticCache = null;
let staticAt = 0;
async function staticItems(env, ctx, domain, start, end) {
  if (!env.STATIC_JSON_URL) return [];
  try {
    if (!staticCache || Date.now() - staticAt > 600000) {
      staticAt = Date.now();
      ctx.take();
      const r = await fetch(env.STATIC_JSON_URL, { cf: { cacheTtl: 600 } });
      staticCache = r.ok ? await r.json() : { items: [] };
    }
    return (staticCache.items || []).filter((x) => x.domain === domain && x.date >= start && x.date <= end);
  } catch {
    return [];
  }
}

async function buildDomain(env, ctx, domain, start, end, opts) {
  const today = todayCst();
  const resKey = `${VERSION}:res:${domain}:${start}:${end}:${opts.limit}`;
  if (!opts.fresh) {
    const hit = await kvGet(env, resKey);
    if (hit) return { ...hit, cache: 'hit' };
  }
  const g = await gatherDomain(env, ctx, domain, start, end, opts);
  const pool = selectCandidates(g.items, domain, Math.min(26, opts.limit * 2 + 4));

  // reuse the whole LLM result when the candidate set is identical (e.g. scheduled refreshes)
  const poolKey = `${VERSION}:pool:${domain}:${opts.limit}:${await sha1(pool.map((c) => c.url).join('|'))}`;
  const poolHit = pool.length ? await kvGet(env, poolKey) : null;

  // reuse per-item analyses
  const anaKeys = await Promise.all(pool.map((c) => sha1(c.url)));
  const prior = await Promise.all(anaKeys.map((k) => kvGet(env, `${VERSION}:ana:${k}`)));
  let items;
  let llm;
  const priorOk = prior.filter(Boolean);
  if (poolHit && Array.isArray(poolHit.items) && poolHit.items.length) {
    const byUrl = new Map(pool.map((c) => [c.url, c]));
    items = poolHit.items.map((p) => ({ ...(byUrl.get(p.url) || {}), ...p })).filter((p) => p.title);
    llm = { analyzed: true, cache: 'pool-hit', model: poolHit.model };
  } else if (pool.length && priorOk.length >= Math.min(opts.limit, pool.length) && prior.slice(0, opts.limit).every(Boolean)) {
    items = pool.slice(0, opts.limit).map((c, i) => ({ ...c, ...prior[i] }));
    llm = { analyzed: true, cache: 'item-hit' };
  } else {
    const r = await analyze(env, domain, pool, opts.limit, ctx);
    items = r.items;
    llm = { analyzed: r.analyzed, model: r.model, error: r.error ? String(r.error).slice(0, 700) : undefined };
    if (r.analyzed) {
      opts.waitUntil(kvPut(env, poolKey, { model: r.model, items: r.items.map(({ url, summary, sentiment, analysis, importance }) => ({ url, summary, sentiment, analysis, importance })) }, 14 * 86400));
      opts.waitUntil(
        Promise.all(
          r.items.map(async (it) =>
            kvPut(env, `${VERSION}:ana:${await sha1(it.url)}`, { summary: it.summary, sentiment: it.sentiment, analysis: it.analysis, importance: it.importance }, 90 * 86400)
          )
        )
      );
    }
  }
  items = items.map((it) => ({
    domain,
    title: it.title,
    summary: it.summary,
    date: it.date,
    url: it.url,
    source: it.source,
    sentiment: it.sentiment,
    analysis: it.analysis,
    importance: it.importance || 1,
    live: true,
  }));

  // static news.json top-up when live coverage is thin
  let staticUsed = 0;
  if (items.length < Math.min(3, opts.limit)) {
    const st = await staticItems(env, ctx, domain, start, end);
    for (const s of st) {
      if (items.length >= opts.limit) break;
      if (items.some((x) => x.url === s.url)) continue;
      items.push({ ...s, domain, live: false });
      staticUsed++;
    }
  }
  items.sort((a, b) => b.date.localeCompare(a.date));
  const result = { domain, items, sources: g.statuses, llm, candidates: g.items.length, staticUsed, rawCache: g.fromCache };

  const healthy = g.statuses.every((s) => ['ok', 'blocked', 'cached'].includes(s.status)) && llm.analyzed;
  const past = end < today;
  const ttl = past ? (healthy ? 30 * 86400 : 20 * 60) : 20 * 60;
  if (items.length) opts.waitUntil(kvPut(env, resKey, { ...result, cachedAt: new Date().toISOString() }, ttl));
  return { ...result, cache: 'miss' };
}

async function handleNews(req, env, ectx) {
  const u = new URL(req.url);
  const start = u.searchParams.get('start');
  const end = u.searchParams.get('end');
  const today = todayCst();
  if (!isYmd(start) || !isYmd(end)) return json(req, env, { error: 'start/end must be YYYY-MM-DD' }, 400);
  if (start > end) return json(req, env, { error: 'start must be <= end' }, 400);
  const maxDays = Number(env.MAX_RANGE_DAYS || 92);
  if (dayNum(end) - dayNum(start) + 1 > maxDays) return json(req, env, { error: `range too long (max ${maxDays} days)` }, 400);
  const endC = end > today ? today : end;
  const domains = (u.searchParams.get('domains') || DOMAINS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter((d) => DOMAINS.includes(d));
  if (!domains.length) return json(req, env, { error: 'domains must be a subset of ai,policy,energy' }, 400);
  const limit = Math.max(1, Math.min(10, parseInt(u.searchParams.get('limit') || env.DEFAULT_LIMIT || '5', 10)));
  const opts = {
    limit,
    fresh: u.searchParams.get('fresh') === '1',
    probe: u.searchParams.get('probe') === '1',
    deep: u.searchParams.get('deep') === '1', // spend the whole subrequest budget (archive builds)
    waitUntil: (p) => ectx.waitUntil(p),
  };
  const storeMode = u.searchParams.get('store');
  if ((storeMode === '0' || storeMode === 'pool') && env.NEWS_KV) {
    // store=0: read-only KV view (archive builds). store=pool: only the small `:pool:` LLM-result cache may be written
    // (scheduled refresh: unchanged candidate set => no LLM call, and KV write quota is barely used).
    const kv = env.NEWS_KV;
    env = { ...env, NEWS_KV: { get: (...a) => kv.get(...a), put: async (k, ...a) => (storeMode === 'pool' && k.includes(':pool:') ? kv.put(k, ...a) : undefined) } };
  }
  const m = u.searchParams.get('model');
  if (m && /^@cf\/[\w.\/-]+$/.test(m)) { env = { ...env, AI_MODEL: m }; opts.fresh = true; }
  const ctx = new Ctx({
    budget: Number(env.SUBREQUEST_BUDGET || 46),
    deadlineMs: Number(env.SOURCE_DEADLINE_MS || 22000),
    fetchTimeoutMs: Number(env.FETCH_TIMEOUT_MS || 9000),
    log: env.DEBUG === '1',
  });
  const t0 = Date.now();
  // split the subrequest budget across requested domains
  const per = Math.floor(ctx.budget / domains.length);
  const results = await Promise.all(domains.map((d) => buildDomain(env, ctx.child(per), d, start, endC, opts)));
  const body = {
    start,
    end: endC,
    domains,
    generated_at: new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', '+08:00').slice(0, 19) + '+08:00',
    elapsed_ms: Date.now() - t0,
    subrequests: ctx.used,
    items: results.flatMap((r) => r.items),
    sources: results.flatMap((r) => r.sources),
    domain_meta: Object.fromEntries(results.map((r) => [r.domain, { cache: r.cache, llm: r.llm, candidates: r.candidates, staticUsed: r.staticUsed, rawCache: r.rawCache }])),
  };
  return json(req, env, body, 200, { 'Cache-Control': 'public, max-age=300' });
}


/* ---------------------------------------------------------------- POST /api/custom */
function originAllowed(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin) return true; // non-browser client (curl); browsers always send Origin on cross-origin POST
  const allowed = String(env.ALLOWED_ORIGINS || 'https://amosxch.github.io').split(',').map((s) => s.trim());
  return allowed.includes('*') || allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

async function handleCustom(req, env, ectx) {
  if (!originAllowed(req, env)) return json(req, env, { error: 'origin not allowed' }, 403);
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > CUSTOM_LIMITS.maxBody) return json(req, env, { error: '请求体过大' }, 413);
  let raw;
  try {
    raw = await req.text();
  } catch {
    return json(req, env, { error: '无法读取请求体' }, 400);
  }
  if (raw.length > CUSTOM_LIMITS.maxBody) return json(req, env, { error: '请求体过大' }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(req, env, { error: '请求体不是有效 JSON' }, 400);
  }
  const v = validateBody(body, new URL(req.url).hostname, Number(env.MAX_RANGE_DAYS || 92));
  if (v.error) return json(req, env, { error: v.error }, 400);
  const today = todayCst();
  const end = v.end > today ? today : v.end;
  if (v.start > end) return json(req, env, { start: v.start, end, items: [], sources: [], note: '所选日期都在未来' });

  // cache key: normalized config + range
  const norm = JSON.stringify([v.start, end, v.limit, v.sources.map((s) => [s.type, s.name, s.domain, s.url || '', s.keyword, (s.links || []).slice().sort()]).sort()]);
  const key = `${VERSION}:cust:${await sha1(norm)}`;
  if (!v.fresh) {
    const hit = await kvGet(env, key);
    if (hit) return json(req, env, { ...hit, cache: 'hit' }, 200, { 'Cache-Control': 'no-store' });
  }
  const ctx = new Ctx({
    budget: Number(env.SUBREQUEST_BUDGET || 46) - 6, // keep headroom for LLM (OpenAI-compatible override) + KV-free calls
    deadlineMs: Number(env.SOURCE_DEADLINE_MS || 22000),
    fetchTimeoutMs: Number(env.FETCH_TIMEOUT_MS || 9000),
    log: env.DEBUG === '1',
  });
  const t0 = Date.now();
  const g = await gatherCustom(ctx, v.sources, v.start, end, new URL(req.url).hostname);
  const groups = {};
  for (const it of g.items) (groups[it.domain] ||= []).push(it);
  const llmCtx = new Ctx({ budget: 6, deadlineMs: 40000 });
  const domainMeta = {};
  const results = await Promise.all(
    Object.entries(groups).map(async ([domain, list]) => {
      const pool = selectCandidates(list, domain, Math.min(26, v.limit * 2 + 4));
      const r = await analyze(env, domain, pool, v.limit, llmCtx);
      domainMeta[domain] = { candidates: list.length, analyzed: r.analyzed, model: r.model, error: r.error ? String(r.error).slice(0, 300) : undefined };
      return r.items.map((it) => ({
        domain,
        title: it.title,
        summary: it.summary,
        date: it.date,
        url: it.url,
        source: it.source,
        kind: it.kind,
        sentiment: it.sentiment,
        analysis: it.analysis,
        importance: it.importance || 1,
        live: true,
        custom: true,
      }));
    })
  );
  const items = results.flat().sort((a, b) => b.date.localeCompare(a.date));
  const out = {
    start: v.start,
    end,
    generated_at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00',
    elapsed_ms: Date.now() - t0,
    subrequests: ctx.used,
    items,
    sources: g.statuses,
    domain_meta: domainMeta,
    candidates: g.items.length,
  };
  const allOk = g.statuses.every((s) => s.status === 'ok' || s.status === 'empty') && Object.values(domainMeta).every((m) => m.analyzed);
  if (items.length && allOk) opts_put(ectx, kvPut(env, key, out, end < today ? 6 * 3600 : 20 * 60));
  return json(req, env, { ...out, cache: 'miss' }, 200, { 'Cache-Control': 'no-store' });
}
const opts_put = (ectx, p) => (ectx && ectx.waitUntil ? ectx.waitUntil(p) : p);

export default {
  async fetch(req, env, ectx) {
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    try {
      if (u.pathname === '/api/custom') {
        if (req.method !== 'POST') return json(req, env, { error: 'use POST' }, 405);
        return await handleCustom(req, env, ectx);
      }
      if (req.method !== 'GET') return json(req, env, { error: 'method not allowed' }, 405);
      if (u.pathname === '/api/ping')
        return json(req, env, { ok: true, time: new Date().toISOString(), colo: (req.cf && req.cf.colo) || null, country: (req.cf && req.cf.country) || null }, 200, { 'Cache-Control': 'no-store' });
      if (u.pathname === '/api/news') return await handleNews(req, env, ectx);
      if (u.pathname === '/api/sources')
        return json(req, env, Object.fromEntries(Object.entries(SOURCES).map(([d, l]) => [d, l.map((s) => ({ id: s.id, name: s.name, blocked: BLOCKED.has(s.id) }))])));
      if (u.pathname === '/' || u.pathname === '/health')
        return json(req, env, { ok: true, service: 'cf-news-worker', usage: '/api/news?start=YYYY-MM-DD&end=YYYY-MM-DD&domains=ai,policy,energy[&limit=5&fresh=1]' });
      return json(req, env, { error: 'not found' }, 404);
    } catch (e) {
      return json(req, env, { error: String(e.message || e) }, 500);
    }
  },
};
