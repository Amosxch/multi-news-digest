
const DOMAIN_META = {
  ai: { id: 'ai', title: 'AI新闻', className: 'ai' },
  policy: { id: 'policy', title: '国家政策', className: 'policy' },
  energy: { id: 'energy', title: '新能源', className: 'energy' },
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function setRangeDays(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  $('#startDate').value = fmtDate(start);
  $('#endDate').value = fmtDate(end);
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

function render(items, meta) {
  const root = $('#results');
  root.innerHTML = '';
  const domains = selectedDomains();
  let total = 0;

  for (const key of domains) {
    const conf = DOMAIN_META[key];
    const list = items
      .filter((it) => it.domain === key)
      .sort((a, b) => b.date.localeCompare(a.date));
    total += list.length;

    const sec = document.createElement('section');
    sec.className = 'sec';
    sec.id = key;
    sec.innerHTML = `<div class="sec-head"><h2 class="${conf.className}">${conf.title}</h2><span class="count">${list.length} 条</span></div>`;

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '该时间范围内暂无条目';
      sec.appendChild(empty);
    } else {
      for (const it of list) {
        const card = document.createElement('article');
        card.className = 'card';
        card.innerHTML = `
          <a class="title" href="${it.url}" target="_blank" rel="noopener">${escapeHtml(it.title)}</a>
          <div class="meta">
            <div><strong>摘要：</strong>${escapeHtml(it.summary)}</div>
            <div><strong>时间：</strong>${escapeHtml(it.date)}　<strong>来源：</strong>${escapeHtml(it.source)}</div>
            <div><span class="badge ${sentimentClass(it.sentiment)}">${escapeHtml(it.sentiment)}</span>${escapeHtml(it.analysis)}</div>
          </div>`;
        sec.appendChild(card);
      }
    }
    root.appendChild(sec);
  }

  const status = $('#status');
  status.classList.remove('error');
  status.textContent = `已推送 ${total} 条 · ${meta.start} ~ ${meta.end}` +
    (meta.updated_at ? ` · 数据更新于 ${meta.updated_at}` : '');
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function loadNews() {
  const bust = Date.now();
  const res = await fetch(`./data/news.json?t=${bust}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`加载 data/news.json 失败 (${res.status})`);
  return res.json();
}

async function pushNews() {
  const btn = $('#pushBtn');
  const status = $('#status');
  btn.disabled = true;
  status.classList.remove('error');
  status.textContent = '正在按所选时间范围筛选并推送…';

  try {
    const start = $('#startDate').value;
    const end = $('#endDate').value;
    if (!start || !end) throw new Error('请先选择开始和结束日期');
    if (start > end) throw new Error('开始日期不能晚于结束日期');
    if (!selectedDomains().length) throw new Error('请至少选择一个新闻领域');

    const data = await loadNews();
    const items = (data.items || []).filter((it) => it.date >= start && it.date <= end);
    render(items, { start, end, updated_at: data.updated_at || '' });
  } catch (err) {
    status.classList.add('error');
    status.textContent = err.message || String(err);
  } finally {
    btn.disabled = false;
  }
}

function bind() {
  setRangeDays(7);
  $$('.presets button').forEach((btn) => {
    btn.addEventListener('click', () => setRangeDays(Number(btn.dataset.days)));
  });
  $('#startDate').addEventListener('change', () => $$('.presets button').forEach((b) => b.classList.remove('active')));
  $('#endDate').addEventListener('change', () => $$('.presets button').forEach((b) => b.classList.remove('active')));
  $('#pushBtn').addEventListener('click', pushNews);
  $('#resetBtn').addEventListener('click', () => {
    setRangeDays(7);
    $$('.domains input').forEach((el) => { el.checked = true; });
    $('#results').innerHTML = '';
    $('#status').textContent = '已重置，点击「推送新闻」生成简报';
  });
}

bind();
