const DOMAIN_META = {
  ai: { id: 'ai', title: 'AI新闻', className: 'ai' },
  policy: { id: 'policy', title: '国家政策', className: 'policy' },
  energy: { id: 'energy', title: '新能源', className: 'energy' },
};
const MAX_PER_DOMAIN = 10;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 实时抓取服务（Cloudflare Worker）。设为 '' 可关闭实时抓取，仅用 data/news.json
const APP_VERSION = '20260928c'; // 与 version.json / index.html 中的 ?v= 保持一致
const WORKER_URL = 'https://cf-news-worker.amosxch.workers.dev';
const WORKER_TIMEOUT_MS = 90000; // 冷启动 + 多站抓取 + AI 分析，最长约 30~60 秒
const LIVE_CHUNK_DAYS = 31;      // 超出覆盖的区间按 31 天分段请求（每段每领域约 5 条）
const LIVE_MAX_CHUNKS = 6;
const LIVE_LIMIT = 5;

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
      <div><strong>时间：</strong>${escapeHtml(it.date)}　<strong>来源：</strong>${escapeHtml(it.source)}${it.live ? ' <span class="tag-live" title="由实时抓取服务生成">实时</span>' : ''}</div>
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
  if (!segs.length) return '';
  const parts = segs.map(([a, b]) => segText(a, b)).join('、');
  if (!live) return cov.start ? `数据仅覆盖 ${cov.start} ~ ${cov.end}，超出部分（${parts}）暂无数据` : '';
  const covTxt = cov.start ? `精选数据覆盖 ${cov.start} ~ ${cov.end}；` : '';
  return `${covTxt}${parts} ${live.note}`;
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
    const st = state[key] || { state: 'none' };
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

    if (st.state === 'loading') {
      const ld = document.createElement('div');
      ld.className = 'loading';
      ld.innerHTML = `<span class="spinner"></span>正在实时抓取该领域新闻…已用 <b class="elapsed">${Math.round((performance.now() - (meta.t0 || performance.now())) / 1000)}</b> 秒（通常 10~40 秒）`;
      sec.insertBefore(ld, anchor);
    }

    if (!all.length) {
      if (st.state !== 'loading') {
        const empty = document.createElement('div');
        empty.className = 'empty';
        if (st.state === 'done') {
          empty.innerHTML = `实时抓取未找到该时段新闻${domainSourcesHtml(st.sources)}`;
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

  const loadingN = domains.filter((d) => state[d] && state[d].state === 'loading').length;
  const status = $('#status');
  status.classList.remove('error');
  if (loadingN) {
    updateLoadingStatus(meta);
  } else {
    const shownText = shown < total ? `（展示 ${shown} 条重要）` : '';
    status.textContent = `已推送 ${total} 条${shownText} · ${meta.start} ~ ${meta.end}` +
      (meta.cov.start ? ` · 精选数据覆盖 ${meta.cov.start} ~ ${meta.cov.end}` : '') +
      (meta.updated_at ? ` · 更新于 ${fmtUpdated(meta.updated_at)}` : '');
  }

  const note = $('#coverageNote');
  const txt = coverageNote(meta.start, meta.end, meta.cov, meta.live);
  note.textContent = txt;
  note.hidden = !txt;
  renderSources(meta.live, openSrc);
}

function updateLoadingStatus(meta) {
  const state = meta.state || {};
  const domains = meta.domains || [];
  const secs = Math.round((performance.now() - meta.t0) / 1000);
  const parts = domains.map((d) => {
    const st = state[d] || {};
    const mark = st.state === 'loading' ? '…' : st.state === 'failed' ? '✗' : '✓';
    return `${DOMAIN_META[d].title}${mark}`;
  });
  $('#status').innerHTML = `<span class="spinner"></span>正在实时抓取…已用 ${secs} 秒（${escapeHtml(meta.segDesc || '')}；${parts.join(' ')}）`;
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

async function loadNews(force) {
  if (cachedData && !force) return cachedData;
  const bust = Date.now();
  const res = await fetch(`./data/news.json?t=${bust}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`加载 data/news.json 失败 (${res.status})`);
  cachedData = await res.json();
  return cachedData;
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
  const seen = new Set(base.map((it) => it.url));
  const out = base.slice();
  for (const it of extra) {
    if (!it || !it.url || seen.has(it.url)) continue;
    seen.add(it.url);
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

    let data = { items: [] };
    let staticErr = null;
    try { data = await loadNews(true); } catch (e) { staticErr = e; }
    const cov = staticErr ? { start: '', end: '' } : coverageOf(data);
    // 日期均为 YYYY-MM-DD 字符串，按字典序比较即按日期比较（闭区间）
    const staticItems = (data.items || []).filter((it) => DATE_RE.test(it.date || '') && it.date >= start && it.date <= end);
    const segs = WORKER_URL ? chunkSegments(uncoveredSegments(start, end, cov)) : [];
    const meta = { start, end, cov, updated_at: data.updated_at || '', domains, t0: performance.now() };

    if (!segs.length) {
      if (staticErr) throw staticErr;
      render(staticItems, meta);
      return;
    }

    // 先即时展示覆盖范围内的精选数据；未覆盖部分逐领域实时抓取，每个响应到达即渲染
    const state = {};
    for (const d of domains) state[d] = { state: 'loading', pending: segs.length, ok: 0, live: 0, sources: [] };
    const liveItems = [];
    const allSources = [];
    meta.state = state;
    meta.segDesc = segs.map(([a, b]) => segText(a, b)).join('、');
    const live = { note: '正在实时抓取…', sources: allSources };
    meta.live = live;
    const draw = () => { if (seq === pushSeq) render(mergeItems(staticItems, liveItems), meta); };
    draw();
    timer = setInterval(() => { if (seq === pushSeq) updateLoadingStatus(meta); }, 1000);

    const jobs = [];
    for (const [a, b] of segs) {
      for (const d of domains) {
        const url = `${WORKER_URL}/api/news?start=${a}&end=${b}&domains=${d}&limit=${LIVE_LIMIT}`;
        jobs.push(
          fetchWithTimeout(url, WORKER_TIMEOUT_MS)
            .then((j) => {
              const items = (j.items || []).map(normLiveItem);
              liveItems.push(...items);
              allSources.push(...(j.sources || []));
              state[d].sources.push(...(j.sources || []));
              state[d].live += items.length;
              state[d].ok++;
            })
            .catch((e) => {
              state[d].error = e && e.name === 'AbortError' ? `等待超过 ${WORKER_TIMEOUT_MS / 1000} 秒无响应` : /Failed to fetch|NetworkError|Load failed|network/i.test(String(e && e.message)) ? `网络无法连接（${e.message}）` : String((e && e.message) || e);
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
    const liveTotal = domains.reduce((n, d) => n + state[d].live, 0);
    const failed = domains.filter((d) => state[d].state === 'failed');
    if (failed.length === domains.length) {
      live.note = `实时抓取服务连接失败：${state[domains[0]].error || '未知错误'}${staticItems.length ? '；已显示 data/news.json 中的数据' : ''}`;
    } else if (failed.length) {
      live.note = `已实时抓取补充 ${liveTotal} 条（${failed.map((d) => DOMAIN_META[d].title).join('、')} 请求失败）`;
    } else {
      live.note = `已实时抓取补充 ${liveTotal} 条`;
    }
    live.elapsed = performance.now() - meta.t0;
    draw();
    if (failed.length === domains.length) {
      status.classList.add('error');
      status.textContent = live.note;
    }
    if (failed.length === domains.length && !staticItems.length && staticErr) throw staticErr;
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
    const data = await loadNews();
    const cov = coverageOf(data);
    if (cov.start) {
      $('#status').textContent = `数据覆盖 ${cov.start} ~ ${cov.end}` +
        (data.updated_at ? ` · 更新于 ${fmtUpdated(data.updated_at)}` : '') + (WORKER_URL ? ' · 其余日期将实时抓取' : '') + ' · 选好时间后点「推送新闻」';
    }
  } catch (_) { /* 静默：推送时会再报错 */ }
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
    $$('.domains input').forEach((el) => { el.checked = true; });
    $('#results').innerHTML = '';
    $('#coverageNote').hidden = true;
    pushSeq++;
    $('#pushBtn').disabled = false;
    $('#status').textContent = '已重置，点击「推送新闻」生成简报';
  });
  showCoverageHint().then(pingWorker);
  checkVersion();
}

let workerPing = null; // { ok, ms, error }

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
    const j = await fetchWithTimeout(`${WORKER_URL}/api/ping?t=${Date.now()}`, 15000);
    const ms = Math.round(performance.now() - t0);
    workerPing = { ok: !!j.ok, ms };
    el.classList.add('ok');
    el.textContent = `实时抓取服务：已连接（${ms} ms${j.colo ? ' · 节点 ' + j.colo : ''}），超出精选数据的日期将实时抓取`;
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? '15 秒内无响应' : String((e && e.message) || e);
    workerPing = { ok: false, error: msg };
    el.classList.add('bad');
    el.textContent = `实时抓取服务连接失败：${msg}（当前网络可能无法访问 ${WORKER_URL.replace(/^https?:\/\//, '')}），仅能显示精选数据`;
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

bind();
