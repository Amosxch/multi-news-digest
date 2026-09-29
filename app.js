const DOMAIN_META = {
  ai: { id: 'ai', title: 'AI新闻', className: 'ai' },
  policy: { id: 'policy', title: '国家政策', className: 'policy' },
  energy: { id: 'energy', title: '新能源', className: 'energy' },
  custom: { id: 'custom', title: '自定义', className: 'custom' },
};
const KIND_LABEL = { web: '网页', wechat: '公众号' };
const SRC_STORE = 'mnd-sources-v1';        // localStorage：用户自定义来源配置
const CACHE_STORE = 'mnd-custom-cache-v1'; // localStorage：自定义来源抓取结果缓存（离线/Worker 不可达时使用）
const MAX_CUSTOM_SOURCES = 10;
const MAX_CACHE_ENTRIES = 12;
const CUSTOM_LIMIT = 10;
const CUSTOM_MAX_DAYS = 92;
const MAX_PER_DOMAIN = 10;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 实时抓取服务（Cloudflare Worker）。设为 '' 可关闭实时抓取，仅用 data/news.json
const APP_VERSION = '20260929h'; // 与 version.json / index.html 中的 ?v= 保持一致
const WORKER_URL = 'https://cf-news-worker.amosxch.workers.dev';
const WORKER_TIMEOUT_MS = 90000; // 冷启动 + 多站抓取 + AI 分析，最长约 30~60 秒
const LIVE_CHUNK_DAYS = 31;      // 超出覆盖的区间按 31 天分段请求（每段每领域约 5 条）
const LIVE_MAX_CHUNKS = 6;
const LIVE_LIMIT = 5;
const LIVE_TAIL_DAYS = 3;        // 静态归档之外，PC 上仍向 Worker 请求最近几天以获得真正实时的结果
const PING_TIMEOUT_MS = 8000;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let cachedData = null;

// 统一使用本地日期（用户时区）生成 YYYY-MM-DD，避免 toISOString() 的 UTC 偏移
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayStr() {
  return fmtDate(new Date());
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return fmtDate(new Date(y, m - 1, d + n));
}

function fmtUpdated(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : String(s);
}

function setRangeDays(days) {
  const end = todayStr();
  const start = addDays(end, -(days - 1));
  $('#startDate').value = start;
  $('#endDate').value = end;
  $$('.presets button').forEach((b) => b.classList.toggle('active', Number(b.dataset.days) === days));
}

function selectedDomains() {
  return $$('.domains input:checked').map((el) => el.value);
}

function sentimentClass(s) {
  if (s === '利好') return 'bull';
  if (s === '利空') return 'bear';
  return 'neutral';
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeUrl(u) {
  return /^https?:\/\//i.test(u || '') ? u : '#';
}

// 重要度：优先 importance 字段，其次有明确利好/利空判断的条目；同分取更新的
function importance(it) {
  const base = Number(it.importance) || 0;
  return base * 10 + (it.sentiment && it.sentiment !== '中性' ? 1 : 0);
}

function pickTop(list, n) {
  if (list.length <= n) return list.slice();
  const ranked = list
    .map((it, i) => ({ it, i }))
    .sort((a, b) => importance(b.it) - importance(a.it) || b.it.date.localeCompare(a.it.date) || a.i - b.i)
    .slice(0, n)
    .map((x) => x.it);
  return ranked.sort((a, b) => b.date.localeCompare(a.date));
}

function cardHtml(it) {
  return `
    <a class="title" href="${escapeHtml(safeUrl(it.url))}" target="_blank" rel="noopener">${escapeHtml(it.title)}</a>
    <div class="meta">
      <div><strong>摘要：</strong>${escapeHtml(it.summary || '')}</div>
      <div><strong>时间：</strong>${escapeHtml(it.date)}　<strong>来源：</strong>${it.kind && KIND_LABEL[it.kind] ? `<span class="kind-tag ${escapeHtml(it.kind)}">${KIND_LABEL[it.kind]}</span> ` : ''}${escapeHtml(it.source)}${it.custom && it.cached ? ` <span class="tag-cache" title="Worker 不可达，显示的是上次抓取后缓存在本机的结果${it.cachedAt ? '（' + escapeHtml(it.cachedAt) + '）' : ''}">本机缓存</span>` : it.live ? ' <span class="tag-live" title="由实时抓取服务生成">实时</span>' : ''}</div>
      <div><span class="badge ${sentimentClass(it.sentiment || '中性')}">${escapeHtml(it.sentiment || '中性')}</span>${escapeHtml(it.analysis || (it.live ? '（未生成AI分析）' : ''))}</div>
    </div>`;
}

function renderList(sec, list) {
  sec.querySelectorAll('article.card').forEach((el) => el.remove());
  const anchor = sec.querySelector('.more');
  for (const it of list) {
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = cardHtml(it);
    sec.insertBefore(card, anchor);
  }
}

function coverageOf(data) {
  const cov = data.coverage || {};
  if (!data.items) return { start: cov.start || '', end: cov.end || '' };
  let { start, end } = cov;
  if (!DATE_RE.test(start || '') || !DATE_RE.test(end || '')) {
    const dates = (data.items || []).map((it) => it.date).filter((d) => DATE_RE.test(d || '')).sort();
    start = dates[0] || '';
    end = dates[dates.length - 1] || '';
  }
  return { start, end };
}

// 返回 [start,end] 中未被 news.json 覆盖的日期段
function uncoveredSegments(start, end, cov) {
  if (!cov.start || !cov.end || end < cov.start || start > cov.end) return [[start, end]];
  const segs = [];
  if (start < cov.start) segs.push([start, addDays(cov.start, -1)]);
  if (end > cov.end) segs.push([addDays(cov.end, 1), end]);
  return segs;
}

function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// 长区间切成 ≤ LIVE_CHUNK_DAYS 的小段（从最近往前，超过上限的更早部分不请求）
function chunkSegments(segs) {
  const out = [];
  for (const [a, b] of segs.slice().sort((x, y) => y[0].localeCompare(x[0]))) {
    let e = b;
    while (e >= a && out.length < LIVE_MAX_CHUNKS) {
      let s = addDays(e, -(LIVE_CHUNK_DAYS - 1));
      if (s < a) s = a;
      out.push([s, e]);
      e = addDays(s, -1);
    }
  }
  return out;
}

const segText = (a, b) => (a === b ? a : `${a} ~ ${b}`);

function coverageNote(start, end, cov, live) {
  const segs = uncoveredSegments(start, end, cov);
  const parts = segs.map(([a, b]) => segText(a, b)).join('、');
  if (!live) return segs.length && cov.start ? `静态归档仅覆盖 ${cov.start} ~ ${cov.end}，超出部分（${parts}）暂无数据` : '';
  const covTxt = cov.start ? `静态归档覆盖 ${cov.start} ~ ${cov.end}；` : '';
  return segs.length || live.sources.length || /正在|已实时/.test(live.note) ? `${covTxt}${segs.length ? parts : '最近几天'} ${live.note}` : live.note;
}

// meta.state[domain] = { state: 'none' | 'loading' | 'done' | 'failed', live: 实时条数, sources: [...] }
function render(items, meta) {
  const root = $('#results');
  const openSrc = !!($('#sourceStatus') && $('#sourceStatus').open);
  root.innerHTML = '';
  const domains = meta.domains || selectedDomains();
  const state = meta.state || {};
  let total = 0;
  let shown = 0;

  for (const key of domains) {
    const conf = DOMAIN_META[key];
    const st = key === 'custom' ? customDomainState(meta) : state[key] || { state: 'none' };
    const all = items
      .filter((it) => it.domain === key)
      .sort((a, b) => b.date.localeCompare(a.date));
    const top = pickTop(all, MAX_PER_DOMAIN);
    total += all.length;
    shown += top.length;

    const sec = document.createElement('section');
    sec.className = 'sec';
    sec.id = key;
    const countText = all.length > top.length ? `显示 ${top.length} / 共 ${all.length} 条` : `${all.length} 条`;
    const headCount = st.state === 'loading' ? (all.length ? `${countText} · 实时抓取中…` : '实时抓取中…') : countText;
    sec.innerHTML = `<div class="sec-head"><h2 class="${conf.className}">${conf.title}</h2><span class="count">${headCount}</span></div><div class="more"></div>`;
    const anchor = sec.querySelector('.more');

    if (key === 'custom' && st.state === 'loading') {
      const ld = document.createElement('div');
      ld.className = 'loading';
      ld.innerHTML = `<span class="spinner"></span>正在抓取你的自定义来源…已用 <b class="elapsed">${Math.round((performance.now() - (meta.t0 || performance.now())) / 1000)}</b> 秒${all.length ? '（先显示本机缓存）' : ''}`;
      sec.insertBefore(ld, anchor);
    } else if (st.state === 'loading') {
      const ld = document.createElement('div');
      ld.className = 'loading';
      ld.innerHTML = `<span class="spinner"></span>${st.critical === false ? '正在检查最新新闻（已先显示归档数据）' : '正在实时抓取该领域新闻'}…已用 <b class="elapsed">${Math.round((performance.now() - (meta.t0 || performance.now())) / 1000)}</b> 秒（通常 10~40 秒）`;
      sec.insertBefore(ld, anchor);
    }

    if (!all.length) {
      if (st.state !== 'loading') {
        const empty = document.createElement('div');
        empty.className = 'empty';
        if (key === 'custom') {
          empty.innerHTML = customEmptyHtml(st);
        } else if (st.state === 'done') {
          empty.innerHTML = `实时抓取未找到该时段新闻${domainSourcesHtml(st.sources)}`;
        } else if (st.state === 'failed' && !st.critical) {
          empty.textContent = '静态归档中该时段暂无条目（实时服务当前不可用）';
        } else if (st.state === 'failed') {
          empty.innerHTML = `实时抓取服务连接失败：${escapeHtml(st.error || '未知错误')}。请检查网络能否访问 ${escapeHtml(WORKER_URL.replace(/^https?:\/\//, ''))}，或稍后重试`;
        } else {
          empty.textContent = '该时间范围内暂无条目';
        }
        sec.insertBefore(empty, anchor);
      }
    } else {
      renderList(sec, top);
      if (all.length > top.length) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost btn-more';
        btn.textContent = `展开全部 ${all.length} 条`;
        let expanded = false;
        btn.addEventListener('click', () => {
          expanded = !expanded;
          renderList(sec, expanded ? all : top);
          sec.querySelector('.count').textContent = expanded ? `共 ${all.length} 条` : countText;
          btn.textContent = expanded ? `收起，仅看重要 ${top.length} 条` : `展开全部 ${all.length} 条`;
        });
        anchor.appendChild(btn);
      }
    }
    root.appendChild(sec);
  }

  const loadingN = domains.filter((d) => state[d] && state[d].state === 'loading').length + (meta.custom && meta.custom.state === 'loading' ? 1 : 0);
  const status = $('#status');
  status.classList.remove('error');
  if (loadingN) {
    updateLoadingStatus(meta);
  } else {
    const shownText = shown < total ? `（展示 ${shown} 条重要）` : '';
    status.textContent = `已推送 ${total} 条${shownText} · ${meta.start} ~ ${meta.end}` +
      (meta.cov.start ? ` · 归档覆盖 ${meta.cov.start} ~ ${meta.cov.end}` : '') +
      (meta.updated_at ? ` · 数据更新于 ${fmtUpdated(meta.updated_at)}` : '');
  }

  const note = $('#coverageNote');
  const txt = coverageNote(meta.start, meta.end, meta.cov, meta.live);
  note.textContent = txt;
  note.hidden = !txt;
  renderSources(meta.live, openSrc);
  renderCustomStatus(meta, !!($('#customStatus') && $('#customStatus').open));
  renderCustomNote(meta);
}

function updateLoadingStatus(meta) {
  const state = meta.state || {};
  const domains = meta.domains || [];
  const secs = Math.round((performance.now() - meta.t0) / 1000);
  const parts = domains.filter((d) => d !== 'custom' && state[d]).map((d) => {
    const st = state[d];
    const mark = st.state === 'loading' ? '…' : st.state === 'failed' ? '✗' : '✓';
    return `${DOMAIN_META[d].title}${mark}`;
  });
  if (meta.custom && meta.custom.state !== 'none') parts.push(`自定义来源${meta.custom.state === 'loading' ? '…' : meta.custom.state === 'done' ? '✓' : '✗'}`);
  $('#status').innerHTML = `<span class="spinner"></span>正在实时抓取…已用 ${secs} 秒（${escapeHtml(meta.segDesc || '')}${meta.segDesc ? '；' : ''}${parts.join(' ')}）`;
  $$('#results .loading .elapsed').forEach((el) => { el.textContent = String(secs); });
}

function domainSourcesHtml(sources) {
  if (!sources || !sources.length) return '';
  const rows = aggregateSources(sources).map((s) => `${escapeHtml(s.name)}：${SRC_STATUS_TEXT[s.status] || escapeHtml(s.status)}${s.status === 'blocked' ? '' : `（候选 ${s.count}）`}`);
  return `<div class="empty-src">来源状态：${rows.join('；')}</div>`;
}

function aggregateSources(sources) {
  const agg = new Map();
  const rank = { error: 4, partial: 3, blocked: 2, cached: 1, ok: 0 };
  for (const s of sources) {
    const k = s.domain + ':' + s.id;
    const cur = agg.get(k) || { ...s, count: 0, errors: [] };
    cur.count += Number(s.count) || 0;
    if ((rank[s.status] || 0) > (rank[cur.status] || 0)) cur.status = s.status;
    if (s.error) cur.errors.push(s.error);
    agg.set(k, cur);
  }
  return [...agg.values()];
}

const SRC_STATUS_TEXT = { ok: '成功', cached: '缓存', partial: '部分', error: '失败', blocked: '跳过', unreachable: '不可达' };

function renderSources(live, open) {
  let box = $('#sourceStatus');
  if (!live || !live.sources || !live.sources.length) {
    if (box) box.remove();
    return;
  }
  if (!box || !box.isConnected) {
    box = document.createElement('details');
    box.id = 'sourceStatus';
    box.className = 'src-status';
    $('#results').prepend(box);
  }
  const list = aggregateSources(live.sources);
  const rows = list.map((s) => {
    const cls = s.status === 'ok' || s.status === 'cached' ? 'ok' : s.status === 'blocked' ? 'skip' : 'bad';
    const tip = s.errors.length ? s.errors[0] : s.note || '';
    return `<li class="${cls}" title="${escapeHtml(tip)}"><span class="dot"></span>${escapeHtml(DOMAIN_META[s.domain] ? DOMAIN_META[s.domain].title : s.domain)} · ${escapeHtml(s.name)}：${SRC_STATUS_TEXT[s.status] || escapeHtml(s.status)}${s.status === 'blocked' ? '' : `（候选 ${s.count}）`}</li>`;
  });
  const okN = list.filter((s) => s.status === 'ok' || s.status === 'cached').length;
  box.open = !!open;
  box.innerHTML = `<summary>实时来源状态：${okN}/${list.length} 个来源可用${live.elapsed ? ` · 用时 ${(live.elapsed / 1000).toFixed(1)}s` : ''}</summary><ul>${rows.join('')}</ul>`;
}

// ---- 静态数据层：data/index.json + data/archive/YYYY-MM.json（仅加载与所选区间相交的月份）+ data/news.json（精选） ----
const monthCache = new Map();

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url.replace(/\?.*$/, '')} (${res.status})`);
  return res.json();
}

async function loadIndex(force) {
  if (cachedData && !force) return cachedData;
  try {
    cachedData = await getJson(`./data/index.json?t=${Date.now()}`);
  } catch (e) {
    cachedData = null;
    throw new Error('加载 data/index.json 失败：' + e.message);
  }
  return cachedData;
}

function monthsBetween(start, end) {
  const out = [];
  let [y, m] = start.slice(0, 7).split('-').map(Number);
  const [ey, em] = end.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function loadMonth(index, month) {
  const entry = (index.months || []).find((x) => x.month === month);
  if (!entry) return [];
  const key = month + '|' + (index.updated_at || '');
  if (monthCache.has(key)) return monthCache.get(key);
  const p = getJson(`./data/${entry.file}?v=${encodeURIComponent(index.updated_at || '')}`).then((j) => j.items || []);
  monthCache.set(key, p);
  p.catch(() => monthCache.delete(key));
  return p;
}

// 返回区间内的静态条目（归档 + 精选 news.json，按 URL 去重，精选优先）
async function loadStaticItems(start, end, index) {
  const errs = [];
  const lists = await Promise.all(monthsBetween(start, end).map((m) => loadMonth(index, m).catch((e) => { errs.push(e.message); return []; })));
  let curated = [];
  try { curated = (await getJson(`./data/news.json?t=${Date.now()}`)).items || []; } catch (_) { /* 精选文件缺失不致命 */ }
  const seen = new Set();
  const out = [];
  for (const it of [...curated, ...lists.flat()]) {
    if (!it || !it.url || seen.has(it.url) || !DATE_RE.test(it.date || '') || it.date < start || it.date > end) continue;
    seen.add(it.url);
    out.push(it);
  }
  return { items: out, errors: errs };
}

async function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal, mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Worker 的 importance 为 1-3；news.json 只用 2 标记重点，这里对齐刻度：3→2，其余→0
function normLiveItem(it) {
  return { ...it, importance: it.live === false ? it.importance : (Number(it.importance) >= 3 ? 2 : 0), live: it.live !== false };
}

function mergeItems(base, extra) {
  const key = (it) => `${it.domain}|${it.url}`;
  const seen = new Set(base.map(key));
  const out = base.slice();
  for (const it of extra) {
    if (!it || !it.url || seen.has(key(it))) continue;
    seen.add(key(it));
    out.push(it);
  }
  return out;
}

let pushSeq = 0;

async function pushNews() {
  const btn = $('#pushBtn');
  const status = $('#status');
  const seq = ++pushSeq;
  btn.disabled = true;
  status.classList.remove('error');
  status.textContent = '正在按所选时间范围筛选并推送…';
  let timer = null;

  try {
    const start = $('#startDate').value;
    const end = $('#endDate').value;
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) throw new Error('请先选择完整的开始和结束日期');
    if (start > end) throw new Error('开始日期不能晚于结束日期');
    if (end > todayStr()) throw new Error('结束日期不能晚于今天');
    const domains = selectedDomains();
    if (!domains.length) throw new Error('请至少选择一个新闻领域');
    const newsDomains = domains.filter((d) => d !== 'custom');
    const wantCustom = customActiveSources(domains).length > 0;
    const skippedSrc = skippedInvalidCount(domains);

    let index = null;
    let staticErr = null;
    try { index = await loadIndex(true); } catch (e) { staticErr = e; }
    const cov = index ? coverageOf(index) : { start: '', end: '' };
    let staticItems = [];
    if (index) {
      const r = await loadStaticItems(start, end, index);
      staticItems = r.items;
      if (r.errors.length) staticErr = new Error('部分月份文件加载失败：' + r.errors[0]);
    }
    const today = todayStr();
    // 1) 静态归档之外的日期（必须靠实时服务）  2) 归档之内但属于最近几天（PC 上尽量取实时结果，失败则静默使用归档）
    const must = WORKER_URL && newsDomains.length ? chunkSegments(uncoveredSegments(start, end, cov)) : [];
    const tailStart = addDays(today, -(LIVE_TAIL_DAYS - 1));
    const tailA = start > tailStart ? start : tailStart;
    const tail = WORKER_URL && newsDomains.length && end >= tailA && !must.some(([a, b]) => a <= tailA && b >= end) ? [[tailA, end]] : [];
    const mustCover = (a, b) => must.some(([x, y]) => x <= a && y >= b);
    const segs = [...must, ...tail.filter(([a, b]) => !mustCover(a, b))];
    const meta = { start, end, cov, updated_at: index ? index.updated_at || '' : '', domains, t0: performance.now(), static: true, custom: { state: 'none' }, skipped: skippedSrc };
    const liveItems = [];
    const customItems = [];
    const draw = () => { if (seq === pushSeq) render(mergeItems(customItems, mergeItems(staticItems, liveItems)), meta); };

    if (!segs.length) {
      if (staticErr && !staticItems.length && !wantCustom) throw staticErr;
      if (newsDomains.length && pingPromise) { try { await pingPromise; } catch (_) { /* 忽略 */ } }
      if (newsDomains.length && workerPing && workerPing.ok === false) {
        meta.live = { note: `实时服务不可达，当前显示的是静态归档${index && index.updated_at ? `（数据更新于 ${fmtUpdated(index.updated_at)}）` : ''}`, sources: [] };
      }
      draw();
      if (wantCustom) {
        timer = setInterval(() => { if (seq === pushSeq) updateLoadingStatus(meta); }, 1000);
        await runCustom(seq, start, end, domains, meta, customItems, draw);
        if (seq === pushSeq) draw();
      }
      return;
    }

    // 先即时展示静态数据；其余部分逐领域实时抓取，每个响应到达即渲染
    const critical = must.length > 0;
    const state = {};
    for (const d of newsDomains) state[d] = { state: 'loading', pending: segs.length, ok: 0, live: 0, sources: [], critical };
    const allSources = [];
    meta.state = state;
    meta.segDesc = segs.map(([a, b]) => segText(a, b)).join('、');
    meta.critical = critical;
    const live = { note: '正在实时抓取…', sources: allSources };
    meta.live = live;
    draw();
    timer = setInterval(() => { if (seq === pushSeq) updateLoadingStatus(meta); }, 1000);

    // 先确认实时服务可达（手机在国内网络下通常不可达，避免傻等）
    if (pingPromise) { try { await pingPromise; } catch (_) { /* 状态在 workerPing 里 */ } }
    const unreachable = workerPing && workerPing.ok === false;

    const jobs = [];
    if (wantCustom) jobs.push(runCustom(seq, start, end, domains, meta, customItems, draw));
    for (const [a, b] of segs) {
      for (const d of newsDomains) {
        const url = `${WORKER_URL}/api/news?start=${a}&end=${b}&domains=${d}&limit=${LIVE_LIMIT}`;
        const p = unreachable ? Promise.reject(Object.assign(new Error(`网络无法连接（${workerPing.error || 'ping 失败'}）`), { final: true })) : fetchWithTimeout(url, WORKER_TIMEOUT_MS);
        jobs.push(
          p
            .then((j) => {
              const items = (j.items || []).map(normLiveItem);
              liveItems.push(...items);
              allSources.push(...(j.sources || []));
              state[d].sources.push(...(j.sources || []));
              state[d].live += items.length;
              state[d].ok++;
            })
            .catch((e) => {
              state[d].error = e && e.final ? e.message : e && e.name === 'AbortError' ? `等待超过 ${WORKER_TIMEOUT_MS / 1000} 秒无响应` : /Failed to fetch|NetworkError|Load failed|network/i.test(String(e && e.message)) ? `网络无法连接（${e.message}）` : String((e && e.message) || e);
            })
            .finally(() => {
              if (--state[d].pending === 0) state[d].state = state[d].ok ? 'done' : 'failed';
              draw();
            })
        );
      }
    }
    await Promise.all(jobs);
    if (seq !== pushSeq) return; // 已有新的推送
    clearInterval(timer);
    timer = null;
    const liveTotal = newsDomains.reduce((n, d) => n + state[d].live, 0);
    const failed = newsDomains.filter((d) => state[d].state === 'failed');
    const upd = index && index.updated_at ? `，数据更新于 ${fmtUpdated(index.updated_at)}` : '';
    if (failed.length === newsDomains.length) {
      live.note = critical
        ? `实时抓取服务连接失败：${state[newsDomains[0]].error || '未知错误'}。该时段不在静态归档范围内，无法显示`
        : `实时服务当前不可用（${state[newsDomains[0]].error || '未知错误'}），已显示静态归档数据${upd}`;
    } else if (failed.length) {
      live.note = `已实时抓取补充 ${liveTotal} 条（${failed.map((d) => DOMAIN_META[d].title).join('、')} 请求失败）`;
    } else {
      live.note = `已实时抓取补充 ${liveTotal} 条`;
    }
    live.elapsed = performance.now() - meta.t0;
    draw();
    if (failed.length === newsDomains.length && critical) {
      status.classList.add('error');
      status.textContent = live.note;
    }
  } catch (err) {
    status.classList.add('error');
    status.textContent = err.message || String(err);
  } finally {
    if (timer) clearInterval(timer);
    if (seq === pushSeq) btn.disabled = false;
  }
}

function applyDateLimits() {
  const today = todayStr();
  $('#startDate').max = today;
  $('#endDate').max = today;
}

async function showCoverageHint() {
  try {
    const data = await loadIndex();
    const cov = coverageOf(data);
    if (cov.start) {
      $('#status').textContent = `静态归档覆盖 ${cov.start} ~ ${cov.end}` +
        (data.updated_at ? ` · 数据更新于 ${fmtUpdated(data.updated_at)}` : '') + ' · 选好时间后点「推送新闻」';
    }
  } catch (e) {
    $('#status').classList.add('error');
    $('#status').textContent = e.message;
  }
}

function bind() {
  applyDateLimits();
  setRangeDays(7);
  $$('.presets button').forEach((btn) => {
    btn.addEventListener('click', () => { applyDateLimits(); setRangeDays(Number(btn.dataset.days)); });
  });
  const clearPreset = () => $$('.presets button').forEach((b) => b.classList.remove('active'));
  for (const ev of ['change', 'input']) {
    $('#startDate').addEventListener(ev, clearPreset);
    $('#endDate').addEventListener(ev, clearPreset);
  }
  $('#pushBtn').addEventListener('click', pushNews);
  $('#resetBtn').addEventListener('click', () => {
    applyDateLimits();
    setRangeDays(7);
    $$('.domains input').forEach((el) => { el.checked = el.value !== 'custom' || sourcesStore.some((x) => x.domain === 'custom'); });
    $('#results').innerHTML = '';
    $('#customNote').hidden = true;
    $('#coverageNote').hidden = true;
    pushSeq++;
    $('#pushBtn').disabled = false;
    $('#status').textContent = '已重置，点击「推送新闻」生成简报';
  });
  try { initSettings(); } catch (e) {
    console.error('initSettings failed', e);
    const m = $('#srcMsg'); if (m) { m.textContent = '来源设置初始化失败：' + (e && e.message ? e.message : e) + '（请强制刷新页面，或清除本站数据后重试）'; m.classList.add('error'); }
  }
  showCoverageHint();
  pingPromise = pingWorker();
  checkVersion();
}

let workerPing = null; // { ok, ms, error }
let pingPromise = null;

async function pingWorker() {
  if (!WORKER_URL) return;
  const el = $('#pingStatus') || (() => {
    const span = document.createElement('div');
    span.id = 'pingStatus';
    span.className = 'ping';
    $('.actions').after(span);
    return span;
  })();
  el.className = 'ping';
  el.textContent = '实时抓取服务：检测中…';
  const t0 = performance.now();
  try {
    const j = await fetchWithTimeout(`${WORKER_URL}/api/ping?t=${Date.now()}`, PING_TIMEOUT_MS);
    const ms = Math.round(performance.now() - t0);
    workerPing = { ok: !!j.ok, ms };
    el.classList.add('ok');
    el.textContent = `实时抓取服务：已连接（${ms} ms${j.colo ? ' · 节点 ' + j.colo : ''}），最近几天、归档之外的日期以及自定义来源将实时抓取`;
    setSrcPing(true, `当前网络可以访问 Worker（${ms} ms）：自定义来源可实时抓取。`);
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? `${PING_TIMEOUT_MS / 1000} 秒内无响应` : String((e && e.message) || e);
    workerPing = { ok: false, error: msg };
    el.classList.add('bad');
    el.textContent = `实时抓取服务不可达：${msg}（当前网络无法访问 ${WORKER_URL.replace(/^https?:\/\//, '')}）。将改用静态归档中的新闻（截至归档更新时间，最近几天可能缺失）；自定义来源只能显示本机缓存的上次结果`;
    setSrcPing(false, `当前网络无法访问 Worker（${msg}）：自定义来源无法更新，只显示本机缓存的上次结果。中国大陆手机网络通常如此，可换用电脑 / 海外网络 / 能访问 workers.dev 的网络。`);
  }
}

// 防止浏览器/GitHub Pages 缓存（max-age=600）导致用旧版页面：发现新版本就带版本号重新加载一次
async function checkVersion() {
  try {
    const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    if (!version || version === APP_VERSION) return;
    const key = 'mnd-reload-' + version;
    if (sessionStorage.getItem(key)) return; // 只尝试一次，避免循环
    sessionStorage.setItem(key, '1');
    const u = new URL(location.href);
    u.searchParams.set('v', version);
    location.replace(u.toString());
  } catch (_) { /* 忽略 */ }
}

// ================== 自定义来源（网页 / 微信公众号）==================
let sourcesStore = [];

function loadSources() {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(SRC_STORE) || '[]'); } catch (_) { arr = []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object' || (x.type !== 'web' && x.type !== 'wechat')) continue;
    const links = Array.isArray(x.links) ? x.links.filter((l) => typeof l === 'string') : [];
    out.push({
      id: String(x.id || uid()),
      type: x.type,
      name: typeof x.name === 'string' ? x.name.slice(0, 30) : '',
      url: typeof x.url === 'string' ? x.url : '',
      links: links.slice(0, 10),
      linksText: typeof x.linksText === 'string' ? x.linksText : links.join('\n'),
      keyword: typeof x.keyword === 'string' ? x.keyword.slice(0, 80) : '',
      domain: ['ai', 'policy', 'energy', 'custom'].includes(x.domain) ? x.domain : 'custom',
      enabled: x.enabled !== false,
    });
    if (out.length >= MAX_CUSTOM_SOURCES) break;
  }
  return out;
}
function saveSources() {
  try { localStorage.setItem(SRC_STORE, JSON.stringify(sourcesStore)); return true; } catch (_) { return false; }
}
function uid() { return 's' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3); }

// 与 Worker 一致的前置校验（Worker 仍会再次校验并做 SSRF 防护）
function checkUrlClient(raw, opts = {}) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) { return '不是有效的网址（需以 http:// 或 https:// 开头）'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '只允许 http/https 地址';
  if (u.username || u.password) return '地址不能包含账号密码';
  const h = u.hostname.toLowerCase();
  if (h.includes(':') || /^\d+(\.\d+){0,3}$/.test(h) || /^0x/i.test(h)) return '不允许使用 IP 地址，请使用域名';
  if (!h.includes('.') || h === 'localhost' || /\.(local|localhost|internal|intranet|lan|home|corp|test|invalid|example)$/.test(h)) return '不允许内网/本地地址';
  if (h.endsWith('.workers.dev')) return '不允许 workers.dev 地址';
  if (opts.wechat && h !== 'mp.weixin.qq.com') return '文章链接必须来自 mp.weixin.qq.com';
  return '';
}

// 校验一条来源，返回 { name, url, links } 的错误文字（无错误则为空对象）
function parseLinks(text) {
  return [...new Set(String(text || '').match(/https?:\/\/[^\s"'<>，。；;]+/g) || [])];
}
function validateSrc(s) {
  const err = {};
  if (!String(s.name || '').trim()) err.name = '请填写名称';
  const url = String(s.url || '').trim();
  const links = parseLinks(s.linksText);
  if (s.type === 'web') {
    if (!url) err.url = '请填写网址（文章列表页或 RSS/Atom）';
    else { const e = checkUrlClient(url); if (e) err.url = e; }
  } else {
    if (url) { const e = checkUrlClient(url); if (e) err.url = e; }
    if (String(s.linksText || '').trim() && !links.length) err.links = '没有识别到链接，请粘贴 https://mp.weixin.qq.com/s/… 文章链接（每行一条）';
    else if (links.length > 10) err.links = `文章链接最多 10 条（现有 ${links.length} 条）`;
    else for (const l of links) { const e = checkUrlClient(l, { wechat: true }); if (e) { err.links = `${l.slice(0, 48)}…：${e}`; break; } }
    if (!url && !links.length && !err.links) err.url = '请填写 RSS/Atom 地址，或在下方粘贴 mp.weixin.qq.com 文章链接';
  }
  return err;
}
const isValidSrc = (s) => !Object.keys(validateSrc(s)).length;
function normSrc(s) {
  return { id: s.id, type: s.type, name: s.name.trim(), url: s.url.trim(), links: s.type === 'wechat' ? parseLinks(s.linksText) : [], keyword: (s.keyword || '').trim(), domain: s.domain, enabled: s.enabled };
}
function customActiveSources(domains) {
  return sourcesStore.filter((s) => s.enabled && domains.includes(s.domain) && isValidSrc(s)).map(normSrc);
}
function skippedInvalidCount(domains) {
  return sourcesStore.filter((s) => s.enabled && domains.includes(s.domain) && !isValidSrc(s)).length;
}
function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const srcSig = (s) => hashStr(JSON.stringify([s.type, s.name, s.url, s.links, s.keyword])); // 不含「归入领域」，改归属不会使缓存失效
const sigOf = (list) => hashStr(JSON.stringify(list.map(srcSig).sort()));

function readCache() {
  try { const c = JSON.parse(localStorage.getItem(CACHE_STORE) || '{}'); return c && typeof c === 'object' && c.entries ? c : { entries: {} }; } catch (_) { return { entries: {} }; }
}
function writeCache(c) {
  const keys = Object.keys(c.entries).sort((a, b) => (c.entries[b].atMs || 0) - (c.entries[a].atMs || 0));
  for (const k of keys.slice(MAX_CACHE_ENTRIES)) delete c.entries[k];
  for (let i = 0; i < 6; i++) {
    try { localStorage.setItem(CACHE_STORE, JSON.stringify(c)); return true; } catch (_) {
      const ks = Object.keys(c.entries).sort((a, b) => (c.entries[a].atMs || 0) - (c.entries[b].atMs || 0));
      if (!ks.length) return false;
      delete c.entries[ks[0]];
    }
  }
  return false;
}
// 在本机缓存里找覆盖所选日期范围、且来源与当前启用来源重叠最多的一条；按当前配置重新映射「归入领域」，只保留仍启用的来源
function cacheLookup(active, start, end) {
  const c = readCache();
  const cur = new Map(active.map((s) => [srcSig(s), s]));
  let best = null;
  for (const e of Object.values(c.entries)) {
    if (!e.srcSigs || e.start > start || e.end < end) continue;
    const common = e.srcSigs.filter((x) => cur.has(x));
    if (!common.length) continue;
    const score = common.length * 1e15 + (e.atMs || 0);
    if (!best || score > best.score) best = { e, common, score };
  }
  if (!best) return null;
  const byName = new Map(best.common.map((x) => [cur.get(x).name, cur.get(x)]));
  const items = best.e.items
    .filter((it) => it.date >= start && it.date <= end && byName.has(it.source))
    .map((it) => ({ ...it, domain: byName.get(it.source).domain }));
  const srcs = (best.e.sources || []).filter((x) => byName.has(x.name)).map((x) => ({ ...x, domain: byName.get(x.name).domain }));
  return { at: best.e.at, items, sources: srcs, complete: best.common.length === active.length };
}
function cacheStore(active, start, end, items, sources) {
  const c = readCache();
  const now = new Date();
  const sig = sigOf(active);
  c.entries[`${sig}|${start}|${end}`] = { srcSigs: active.map(srcSig), start, end, atMs: now.getTime(), at: `${fmtDate(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, items, sources };
  writeCache(c);
}

async function postCustom(body) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), WORKER_TIMEOUT_MS);
  try {
    const res = await fetch(`${WORKER_URL}/api/custom`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal, mode: 'cors' });
    let j = null;
    try { j = await res.json(); } catch (_) { /* 非 JSON */ }
    if (!res.ok) throw Object.assign(new Error((j && j.error) || `HTTP ${res.status}`), { server: true });
    return j;
  } finally {
    clearTimeout(t);
  }
}

function netErrorText(e) {
  if (e && e.server) return e.message;
  if (e && e.final) return e.message;
  if (e && e.name === 'AbortError') return `等待超过 ${WORKER_TIMEOUT_MS / 1000} 秒无响应`;
  return `网络无法连接（${(e && e.message) || e}）`;
}

// 抓取自定义来源：先用本机缓存立即显示，再请求 Worker；Worker 不可达/失败时保留缓存并明确提示
async function runCustom(seq, start, end, domains, meta, out, draw) {
  const active = customActiveSources(domains);
  const c = { state: 'loading', n: active.length, sources: [], note: '', error: '', cachedAt: '', fromCache: false, clamped: false };
  meta.custom = c;
  let s0 = start;
  if (daysBetween(s0, end) + 1 > CUSTOM_MAX_DAYS) { s0 = addDays(end, -(CUSTOM_MAX_DAYS - 1)); c.clamped = true; }
  const cached = cacheLookup(active, s0, end);
  if (cached && cached.items.length) {
    c.fromCache = true;
    c.cachedAt = cached.at;
    c.partialCache = !cached.complete;
    c.sources = cached.sources || [];
    out.push(...cached.items.map((it) => ({ ...it, cached: true, cachedAt: cached.at })));
  }
  draw();
  if (pingPromise) { try { await pingPromise; } catch (_) { /* 状态在 workerPing */ } }
  try {
    if (workerPing && workerPing.ok === false) throw Object.assign(new Error(`网络无法连接（${workerPing.error || 'ping 失败'}）`), { final: true });
    const body = {
      start: s0,
      end,
      limit: CUSTOM_LIMIT,
      sources: active.map((s) => ({ id: s.id, type: s.type, name: s.name, url: s.url || undefined, links: s.type === 'wechat' && s.links.length ? s.links : undefined, keyword: s.keyword || undefined, domain: s.domain })),
    };
    const j = await postCustom(body);
    if (seq !== pushSeq) return;
    const items = (j.items || []).map((it) => ({ ...normLiveItem(it), custom: true }));
    out.length = 0;
    out.push(...items);
    c.sources = j.sources || [];
    c.state = 'done';
    c.fromCache = false;
    c.elapsed = j.elapsed_ms;
    c.serverCache = j.cache;
    const okSrc = c.sources.filter((x) => x.status === 'ok' || x.status === 'empty').length;
    c.note = `${active.length} 个来源中 ${okSrc} 个可用，共 ${items.length} 条${j.cache === 'hit' ? '（服务端缓存）' : ''}`;
    // 至少有一个来源成功并给出结果才更新缓存，避免用一次失败覆盖掉可用缓存
    if (items.length || c.sources.every((x) => x.status === 'ok' || x.status === 'empty')) cacheStore(active, s0, end, items, c.sources);
  } catch (e) {
    if (seq !== pushSeq) return;
    c.error = netErrorText(e);
    c.state = c.fromCache ? 'offline' : 'failed';
  }
  draw();
}

function customDomainState(meta) {
  const c = meta.custom || { state: 'none' };
  const has = sourcesStore.some((s) => s.enabled && s.domain === 'custom' && isValidSrc(s));
  return { ...c, hasSources: has, state: c.state === 'none' && has ? 'none' : c.state };
}
function customEmptyHtml(st) {
  const host = WORKER_URL.replace(/^https?:\/\//, '');
  if (!st.hasSources) return '「自定义」领域只显示你在「来源设置」里添加、且「归入」选为「自定义」的来源。目前还没有启用的此类来源。';
  if (st.state === 'failed') return `无法抓取自定义来源：${escapeHtml(st.error || '未知错误')}。本机也没有该来源/日期范围的缓存。自定义来源需要能访问 ${escapeHtml(host)} 的网络（中国大陆手机网络通常不行）。`;
  if (st.state === 'offline') return `无法连接 Worker：${escapeHtml(st.error || '')}。本机缓存里也没有该日期范围的自定义来源条目。`;
  if (st.state === 'done') return '自定义来源在所选日期范围内没有找到新闻（可检查来源状态、关键词过滤或日期范围）';
  return '该时间范围内暂无自定义来源条目，点「推送新闻」抓取';
}

function renderCustomNote(meta) {
  const el = $('#customNote');
  const c = meta.custom;
  if (!c || c.state === 'none') {
    if (meta.skipped) { el.classList.add('bad'); el.textContent = `有 ${meta.skipped} 个已启用的自定义来源没有填写完整（名称/网址缺失或无效），已跳过。请在「来源设置」里补全。`; el.hidden = false; } else el.hidden = true;
    return;
  }
  const host = WORKER_URL.replace(/^https?:\/\//, '');
  el.classList.remove('bad');
  let html = '';
  if (c.state === 'loading') html = `<span class="spinner"></span>正在通过 Worker 抓取 ${c.n} 个自定义来源…${c.fromCache ? `先显示本机缓存（${escapeHtml(c.cachedAt)}）` : ''}`;
  else if (c.state === 'done') html = `自定义来源：${escapeHtml(c.note)}${c.elapsed ? ` · 用时 ${(c.elapsed / 1000).toFixed(1)}s` : ''}，结果已缓存到本机，Worker 不可达时仍可显示。`;
  else if (c.state === 'offline') { el.classList.add('bad'); html = `无法连接 Worker：${escapeHtml(c.error)}。下面的自定义来源结果是<b>本机缓存</b>${c.partialCache ? '（仅含曾抓取过的来源）' : ''}（缓存于 ${escapeHtml(c.cachedAt)}），可能不是最新。中国大陆手机网络通常无法访问 ${escapeHtml(host)}，换用电脑 / 海外网络 / 可访问 workers.dev 的网络即可更新。`; }
  else { el.classList.add('bad'); html = `无法抓取自定义来源：${escapeHtml(c.error)}。本机没有该日期范围的缓存，自定义来源暂无结果；内置来源不受影响。中国大陆手机网络通常无法访问 ${escapeHtml(host)}。`; }
  if (meta.skipped) html += ` 另有 ${meta.skipped} 个已启用来源没填完整，已跳过。`;
  if (c.clamped) html += ` （日期范围超过 ${CUSTOM_MAX_DAYS} 天，自定义来源只取最近 ${CUSTOM_MAX_DAYS} 天）`;
  el.innerHTML = html;
  el.hidden = false;
}

const CUSTOM_STATUS_TEXT = { ok: '成功', empty: '无匹配', partial: '部分', error: '失败' };
function renderCustomStatus(meta, open) {
  let box = $('#customStatus');
  const c = meta.custom;
  if (!c || !c.sources || !c.sources.length) { if (box) box.remove(); return; }
  if (!box || !box.isConnected) {
    box = document.createElement('details');
    box.id = 'customStatus';
    box.className = 'src-status';
    $('#results').prepend(box);
  }
  const rows = c.sources.map((s) => {
    const cls = s.status === 'ok' ? 'ok' : s.status === 'empty' ? 'skip' : 'bad';
    const detail = s.error || s.note || '';
    return `<li class="${cls}" title="${escapeHtml(detail)}"><span class="dot"></span><span class="kind-tag ${escapeHtml(s.kind)}">${KIND_LABEL[s.kind] || ''}</span> ${escapeHtml(s.name)}：${CUSTOM_STATUS_TEXT[s.status] || escapeHtml(s.status)}${s.status === 'error' ? `（${escapeHtml(s.error || '')}）` : `（共 ${s.total ?? 0} 条，范围内 ${s.count ?? 0} 条${s.feed ? ' · ' + escapeHtml(s.feed) : ''}）`}${s.status !== 'error' && s.note ? `<small class="src-note"> ${escapeHtml(s.note)}</small>` : ''}${(s.links || []).filter((l) => !l.ok).map((l) => `<small class="src-note bad"> ✗ ${escapeHtml(l.url.slice(0, 60))}：${escapeHtml(l.error || '')}</small>`).join('')}</li>`;
  });
  box.open = !!open;
  box.className = 'src-status custom-status';
  box.innerHTML = `<summary>自定义来源状态：${c.sources.filter((s) => s.status === 'ok' || s.status === 'empty').length}/${c.sources.length} 个来源可用${c.state === 'offline' ? '（上次抓取，本机缓存）' : ''}</summary><ul class="one-col">${rows.join('')}</ul>`;
}

function setSrcPing(ok, text) {
  const el = $('#srcPing');
  if (!el) return;
  el.className = 'src-ping ' + (ok ? 'ok' : 'bad');
  el.textContent = text;
}

function domainTitle(d) { return (DOMAIN_META[d] || {}).title || d; }

function srcMsg(text, bad) {
  const el = $('#srcMsg');
  el.textContent = text;
  el.classList.toggle('error', !!bad);
}
function catMsg(type, text, bad) {
  const el = $(type === 'web' ? '#msgWeb' : '#msgWechat');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('error', !!bad);
}

function syncCustomCheckbox(force) {
  const cb = $('.domains input[value="custom"]');
  if (!cb) return;
  const has = sourcesStore.some((s) => s.enabled && s.domain === 'custom' && isValidSrc(s));
  if (force && has) cb.checked = true;
}

const PH = {
  web: { name: '名称（如：IT之家）', url: '网址：文章列表页或 RSS/Atom（https://…）' },
  wechat: { name: '公众号名称（如：通威新能源）', url: 'RSS/Atom 地址（wechat2rss / RSSHub / feeddd，可选）' },
};

function rowHtml(s) {
  const ph = PH[s.type];
  const domSel = ['ai', 'policy', 'energy', 'custom'].map((d) => `<option value="${d}" ${s.domain === d ? 'selected' : ''}>${domainTitle(d)}</option>`).join('');
  return `
    <div class="src-row1">
      <label class="switch" title="启用/停用"><input type="checkbox" class="src-toggle" data-f="enabled" ${s.enabled ? 'checked' : ''} aria-label="启用该来源" /><span></span></label>
      <span class="kind-tag ${s.type}">${KIND_LABEL[s.type]}</span>
      <input class="src-in src-name-in" data-f="name" value="${escapeHtml(s.name)}" placeholder="${escapeHtml(ph.name)}" maxlength="30" aria-label="来源名称" autocomplete="off" />
      <select class="src-domain" data-f="domain" aria-label="归入领域">${domSel}</select>
      <button type="button" class="btn btn-ghost src-del" aria-label="删除该来源">删除</button>
    </div>
    <div class="src-row2">
      <input class="src-in" data-f="url" value="${escapeHtml(s.url)}" placeholder="${escapeHtml(ph.url)}" inputmode="url" aria-label="网址" autocomplete="off" />
      ${s.type === 'wechat' ? `<textarea class="src-in" data-f="linksText" rows="2" placeholder="或粘贴 mp.weixin.qq.com/s/… 文章链接，每行一条（最多 10 条）" aria-label="文章链接">${escapeHtml(s.linksText)}</textarea>` : ''}
      <input class="src-in" data-f="keyword" value="${escapeHtml(s.keyword)}" placeholder="关键词过滤（可选；逗号分隔，-开头为排除）" maxlength="80" aria-label="关键词过滤" autocomplete="off" />
    </div>
    <div class="src-state" role="status"></div>`;
}

// 只更新某一行的状态提示/输入框标红，不重绘输入框（避免丢失焦点）
function refreshRowState(li, saved) {
  const s = sourcesStore.find((x) => x.id === li.dataset.id);
  if (!s) return;
  const err = validateSrc(s);
  const msgs = Object.values(err);
  const box = li.querySelector('.src-state');
  li.classList.toggle('off', !s.enabled);
  li.classList.toggle('bad', msgs.length > 0);
  li.querySelectorAll('.src-in').forEach((el) => {
    const f = el.dataset.f;
    el.classList.toggle('invalid', !!err[f] && (el.value.trim() !== '' || f === 'name' && touched.has(s.id)));
  });
  if (msgs.length) {
    box.className = 'src-state bad';
    box.textContent = `${s.enabled ? '暂不生效' : '已停用'}：${msgs.join('；')}`;
  } else {
    box.className = 'src-state ok';
    box.textContent = s.enabled ? `✓ ${saved ? '已自动保存' : '已保存'}，点「推送新闻」后参与抓取（归入「${domainTitle(s.domain)}」）` : '已停用（不参与抓取）';
  }
  updateSrcCount();
}
const touched = new Set();

function updateSrcCount() {
  const total = sourcesStore.length;
  const on = sourcesStore.filter((s) => s.enabled && isValidSrc(s)).length;
  const bad = sourcesStore.filter((s) => s.enabled && !isValidSrc(s)).length;
  $('#srcCount').textContent = total ? `（自定义 ${total}/${MAX_CUSTOM_SOURCES} 个，生效 ${on} 个${bad ? `，${bad} 个未填完整` : ''}）` : '（未添加自定义来源）';
  for (const type of ['web', 'wechat']) {
    const btn = $(type === 'web' ? '#addWeb' : '#addWechat');
    if (btn) btn.classList.toggle('full', total >= MAX_CUSTOM_SOURCES);
  }
}

function renderSettings(focusId) {
  for (const type of ['web', 'wechat']) {
    const ul = $(type === 'web' ? '#listWeb' : '#listWechat');
    const list = sourcesStore.filter((s) => s.type === type);
    ul.innerHTML = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'src-empty';
      li.textContent = type === 'web' ? '还没有网页来源，点下方「＋ 添加网页来源」' : '还没有公众号来源，点下方「＋ 添加公众号来源」';
      ul.appendChild(li);
    }
    for (const s of list) {
      const li = document.createElement('li');
      li.className = 'src-item';
      li.dataset.id = s.id;
      li.innerHTML = rowHtml(s);
      ul.appendChild(li);
      refreshRowState(li);
    }
  }
  $('#srcWorkerHost').textContent = WORKER_URL.replace(/^https?:\/\//, '');
  updateSrcCount();
  if (focusId) {
    const li = document.querySelector(`li.src-item[data-id="${focusId}"]`);
    if (li) {
      const inp = li.querySelector('.src-name-in');
      try { li.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { /* 旧浏览器 */ }
      if (inp) inp.focus({ preventScroll: true });
    }
  }
}

function persist(type) {
  if (!saveSources()) { const m = '保存失败：浏览器禁止写入 localStorage（隐私模式？），刷新后配置会丢失'; catMsg(type, m, true); srcMsg(m, true); return false; }
  return true;
}

// 点击「添加」：立即追加一行可编辑的空白来源，聚焦名称输入框；永不静默失败
function addBlankSource(type) {
  if (sourcesStore.length >= MAX_CUSTOM_SOURCES) {
    const m = `已达上限：最多 ${MAX_CUSTOM_SOURCES} 个自定义来源，请先删除不用的再添加`;
    catMsg(type, m, true);
    srcMsg(m, true);
    return;
  }
  const s = { id: uid(), type, name: '', url: '', links: [], linksText: '', keyword: '', domain: 'custom', enabled: true };
  sourcesStore.push(s);
  persist(type);
  renderSettings(s.id);
  catMsg(type, `已新增一行（第 ${sourcesStore.length}/${MAX_CUSTOM_SOURCES} 个）：填写名称和网址即自动保存并生效，可继续点击添加更多`, false);
  srcMsg('', false);
}

function onRowInput(e) {
  const el = e.target;
  const f = el.dataset && el.dataset.f;
  const li = el.closest && el.closest('li.src-item');
  if (!f || !li) return;
  const s = sourcesStore.find((x) => x.id === li.dataset.id);
  if (!s) return;
  if (f === 'enabled') s.enabled = el.checked;
  else if (f === 'domain') s.domain = ['ai', 'policy', 'energy', 'custom'].includes(el.value) ? el.value : 'custom';
  else s[f] = el.value;
  if (f === 'name') touched.add(s.id);
  if (f === 'linksText') s.links = parseLinks(s.linksText).slice(0, 10);
  if (persist(s.type)) { /* 已保存 */ }
  refreshRowState(li, true);
  syncCustomCheckbox(true);
  catMsg(s.type, '', false);
}

function initSettings() {
  sourcesStore = loadSources();
  renderSettings();
  syncCustomCheckbox(true);
  $('#addWeb').addEventListener('click', () => addBlankSource('web'));
  $('#addWechat').addEventListener('click', () => addBlankSource('wechat'));
  for (const id of ['#listWeb', '#listWechat']) {
    const ul = $(id);
    ul.addEventListener('input', onRowInput);
    ul.addEventListener('change', onRowInput);
    ul.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.src-del');
      if (!btn) return;
      const li = btn.closest('li.src-item');
      const s = sourcesStore.find((x) => x.id === li.dataset.id);
      sourcesStore = sourcesStore.filter((x) => x.id !== li.dataset.id);
      persist(s ? s.type : 'web');
      renderSettings();
      const m = `已删除${s && s.name.trim() ? `「${s.name.trim()}」` : '该来源'}`;
      catMsg(s ? s.type : 'web', m, false);
    });
  }
  $('#clearCacheBtn').addEventListener('click', () => {
    try { localStorage.removeItem(CACHE_STORE); srcMsg('已清除本机缓存的自定义结果（来源配置保留）'); } catch (e) { srcMsg('清除失败：' + e.message, true); }
  });
  if (sourcesStore.length && sourcesStore.every(isValidSrc)) $('#srcSettings').open = false;
  else if (sourcesStore.length) $('#srcSettings').open = true;
}

bind();
