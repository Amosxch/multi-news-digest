import { fetchJson, fetchText, absUrl, normDate, msToYmd, pagedSearch, inRange, stripTags, detectBlock, decodeEntities } from '../util.js';

// ---------- 中国储能网 (escn.com.cn) 国内新闻 ----------
// Category list /news/589.html, /news/589-2.html ... (~7800 pages, 20 items/page, ~1 page/day).
// Random-access pages -> interpolation search reaches any date (tested to 2026-08-01, page ~60).
export const escn = {
  id: 'escn',
  name: '中国储能网',
  domain: 'energy',
  budget: 9,
  async fetch(ctx, start, end) {
    const fetchPage = async (i) => {
      const url = i === 0 ? 'https://www.escn.com.cn/news/589.html' : `https://www.escn.com.cn/news/589-${i + 1}.html`;
      const r = await fetchText(ctx, url);
      if (r.status === 404) return [];
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const out = [];
      const re = /<em>(\d{1,2})<\/em>\s*<span>(\d{4})-(\d{2})<\/span>[\s\S]*?<a href="(\/news\/show-\d+\.html)">([\s\S]*?)<\/a>(?:\s*<p class="item-desc">([\s\S]*?)<\/p>)?/g;
      for (const m of r.text.matchAll(re)) {
        out.push({
          title: stripTags(m[5]),
          url: absUrl(m[4], 'https://www.escn.com.cn/'),
          date: `${m[2]}-${m[3]}-${m[1].padStart(2, '0')}`,
          desc: stripTags(m[6] || ''),
          source: '中国储能网',
        });
      }
      return out;
    };
    return pagedSearch({ start, end, maxProbes: 7, maxRangePages: Math.max(3, ctx.budget - 8), maxPage: 7800, initialDpp: 0.85, fetchPage });
  },
};

// ---------- 36氪 ----------
// 36kr.com HTML is behind a bot challenge from datacenter IPs; www.36kr.com/feed RSS works but
// only holds the newest ~30 items. For history we use the public site-search API that the
// 36kr web client calls (gateway.36kr.com, keyword "储能", sort=date, cursor pagination,
// pageSize=200 accepted -> 200 items ~= 5-6 weeks per request).
const KR_WORDS = ['储能', '新能源'];
export const kr36 = {
  id: 'kr36',
  name: '36氪',
  domain: 'energy',
  budget: 6,
  async fetch(ctx, start, end) {
    const all = [];
    const notes = [];
    // results are newest-first with no date filter: for older ranges spend the whole budget on one keyword
    const ageDays = (Date.now() - Date.parse(start + 'T00:00:00+08:00')) / 86400000;
    const words = ageDays > 35 ? KR_WORDS.slice(0, 1) : KR_WORDS;
    const perWord = Math.floor(ctx.budget / words.length);
    const settled = await Promise.allSettled(
      words.map(async (word) => {
        let cb = null;
        let pages = 0;
        let reached = false;
        while (pages < perWord) {
          const param = { searchType: 'article', searchWord: word, sort: 'date', pageSize: 200, pageEvent: cb ? 1 : 0, siteId: 1, platformId: 2 };
          if (cb) param.pageCallback = cb;
          const init = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: 'https://www.36kr.com', Referer: 'https://www.36kr.com/' },
            body: JSON.stringify({ partner_id: 'web', timestamp: Date.now(), param }),
          };
          let j;
          try {
            j = await fetchJson(ctx, 'https://gateway.36kr.com/api/mis/nav/search/resultbytype', init);
          } catch (e) {
            if (ctx.remaining() < 1) throw e;
            j = await fetchJson(ctx, 'https://gateway.36kr.com/api/mis/nav/search/resultbytype', init); // one retry
          }
          pages++;
          const d = j && j.data;
          if (!d || !Array.isArray(d.itemList)) throw new Error('36kr search: unexpected response');
          let oldest = '9999';
          for (const x of d.itemList) {
            const date = msToYmd(Number(x.publishTime));
            if (date < oldest) oldest = date;
            if (!inRange(date, start, end)) continue;
            all.push({
              title: stripTags(x.widgetTitle),
              url: `https://www.36kr.com/p/${x.itemId}`,
              date,
              desc: stripTags(x.content || ''),
              source: '36氪',
            });
          }
          if (oldest < start || !d.hasNextPage || !d.pageCallback) { reached = true; break; }
          cb = d.pageCallback;
        }
        if (!reached) notes.push(`${word}: search results did not reach ${start}`);
        notes.push(`${word}:${pages}p`);
      })
    );
    const errs = settled.filter((x) => x.status === 'rejected').map((x) => x.reason.message);
    if (errs.length === words.length) throw new Error(errs[0]);
    if (errs.length) notes.push('partial: ' + errs[0].slice(0, 60));
    const seen = new Set();
    const items = all.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
    return { items, note: notes.join(' ') };
  },
};

// ---------- 国家能源局 ----------
// List pages are Vue-rendered from static datasource JSON files:
//   /policy/ds_7290c82b05cc4d49be4971ade193edfc.json  通知 (1000 items, 2015->)  ~1.1MB
//   /news/ds_c9f95ed9895045b9804bbed332636104.json    局工作动态 (670 items, 2018->) ~0.7MB
// Items are newest-first; we scan with a regex and stop once dates fall before `start`
// (cheaper on Worker CPU than JSON.parse of the whole file).
function scanNea(text, start, end, base, label) {
  const out = [];
  const re = /"title":"((?:[^"\\]|\\.)*)"[\s\S]*?"publishUrl":"([^"]*)"[\s\S]*?"summary":"((?:[^"\\]|\\.)*)"[\s\S]*?"publishTime":"(\d{4}-\d{2}-\d{2})/g;
  let m;
  let n = 0;
  while ((m = re.exec(text))) {
    n++;
    const date = m[4];
    if (date < start) break;
    if (date > end) continue;
    let title, summary;
    try { title = JSON.parse(`"${m[1]}"`); } catch { title = m[1]; }
    try { summary = JSON.parse(`"${m[3]}"`); } catch { summary = m[3]; }
    out.push({ title: stripTags(title), url: absUrl(m[2], base), date, desc: stripTags(summary).replace(/^"|"$/g, '').slice(0, 160), source: `国家能源局${label}` });
    if (n > 2000) break;
  }
  return out;
}
export const nea = {
  id: 'nea',
  name: '国家能源局',
  domain: 'energy',
  budget: 2,
  async fetch(ctx, start, end) {
    const feeds = [
      ['https://www.nea.gov.cn/policy/ds_7290c82b05cc4d49be4971ade193edfc.json', 'https://www.nea.gov.cn/policy/tz.htm', '·通知'],
      ['https://www.nea.gov.cn/news/ds_c9f95ed9895045b9804bbed332636104.json', 'https://www.nea.gov.cn/news/jwzdt.htm', ''],
    ];
    const res = await Promise.allSettled(
      feeds.map(async ([u, base, label]) => {
        const r = await fetchText(ctx, u);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return scanNea(r.text, start, end, base, label);
      })
    );
    const items = res.flatMap((x) => (x.status === 'fulfilled' ? x.value : []));
    const errs = res.filter((x) => x.status === 'rejected').map((x) => x.reason.message);
    if (errs.length === feeds.length) throw new Error(errs.join('; '));
    return { items: items.map((x) => ({ ...x, source: '国家能源局' })), note: errs.length ? 'partial: ' + errs.join('; ') : 'datasource json' };
  },
};

// ---------- Sources that are blocked from datacenter egress (kept for status reporting) ----------
function probeOnly(id, name, url, why) {
  return {
    id,
    name,
    domain: 'energy',
    budget: 1,
    async fetch(ctx) {
      const r = await fetchText(ctx, url);
      const block = detectBlock(r.text, r.status);
      if (block || !r.ok) throw new Error(block || `HTTP ${r.status}`);
      // If it ever becomes reachable, try a very generic dated-link scrape of the front page.
      const items = [];
      for (const m of r.text.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]{8,80})<\/a>[\s\S]{0,200}?(20\d{2}-\d{2}-\d{2})/g)) {
        items.push({ title: stripTags(m[2]), url: absUrl(m[1], url), date: m[3], source: name });
      }
      return { items, note: why };
    },
  };
}
export const bjx = probeOnly('bjx', '北极星储能网', 'https://news.bjx.com.cn/list?catid=78', 'Aliyun WAF JS challenge on all bjx.com.cn hosts');
export const inen = probeOnly('inen', '国际能源网', 'https://chuneng.in-en.com/', 'HTTP 403 / HTTP2 reset for non-browser clients');
export const ggii = probeOnly('ggii', '高工储能', 'https://www.gg-ii.com/', 'TLS certificate expired / 503');

export function _filterRange(items, start, end) {
  return items.filter((x) => inRange(x.date, start, end));
}
