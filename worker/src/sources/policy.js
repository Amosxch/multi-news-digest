import { fetchJson, fetchText, absUrl, normDate, pagedSearch, inRange, stripTags } from '../util.js';

// ---------- 中国政府网 最新政策 ----------
// https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json : ~1100 items (2020 -> today) in one file.
export const govcn = {
  id: 'govcn',
  name: '中国政府网',
  domain: 'policy',
  budget: 2,
  async fetch(ctx, start, end) {
    const j = await fetchJson(ctx, 'https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json');
    const arr = Array.isArray(j) ? j : Object.values(j)[0] || [];
    const items = arr
      .map((x) => ({ title: stripTags(x.TITLE), url: x.URL, date: normDate(x.DOCRELPUBTIME), desc: stripTags(x.SUB_TITLE || ''), source: '中国政府网' }))
      .filter((x) => inRange(x.date, start, end));
    const dates = arr.map((x) => x.DOCRELPUBTIME).filter(Boolean).sort();
    return { items, note: `json ${arr.length} items ${dates[0]}..${dates[dates.length - 1]}` };
  },
};

// Generic TRS-CMS paged list: index.htm(l), index_1.htm(l), ...
function trsList(base, ext, parse) {
  return async (ctx, i) => {
    const url = i === 0 ? `${base}index.${ext}` : `${base}index_${i}.${ext}`;
    const r = await fetchText(ctx, url);
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return parse(r.text, url);
  };
}

// ---------- 财政部 政策发布 ----------
// Static pages index.htm, index_1.htm ... (20 pages x ~? items). Low volume: page 0 ~= 2 months.
export const mof = {
  id: 'mof',
  name: '财政部',
  domain: 'policy',
  budget: 5,
  async fetch(ctx, start, end) {
    const page = trsList('https://www.mof.gov.cn/zhengwuxinxi/zhengcefabu/', 'htm', (html, url) => {
      const bi = html.indexOf('xwfb_listbox');
      const box = bi >= 0 ? html.slice(bi) : html;
      return [...box.matchAll(/<li>\s*<a href="([^"]+)"[^>]*title='([^']*)'[^>]*>[\s\S]*?<\/a>\s*<span>(\d{4}-\d{2}-\d{2})<\/span>/g)].map((m) => ({
        title: stripTags(m[2]),
        url: absUrl(m[1], url),
        date: m[3],
        source: '财政部',
      }));
    });
    return pagedSearch({ start, end, maxProbes: 3, maxRangePages: 2, maxPage: 19, fetchPage: (i) => page(ctx, i) });
  },
};

// ---------- 国家发展改革委 通知 ----------
export const ndrc = {
  id: 'ndrc',
  name: '国家发展改革委',
  domain: 'policy',
  budget: 5,
  async fetch(ctx, start, end) {
    const page = trsList('https://www.ndrc.gov.cn/xxgk/zcfb/tz/', 'html', (html, url) =>
      [...html.matchAll(/<li>\s*<a href="([^"]+)"[^>]*title="([^"]*)"[^>]*>[\s\S]*?<span>(\d{4}\/\d{2}\/\d{2})<\/span>\s*<\/li>/g)].map((m) => ({
        title: stripTags(m[2]),
        url: absUrl(m[1], url),
        date: normDate(m[3]),
        source: '国家发展改革委',
      }))
    );
    return pagedSearch({ start, end, maxProbes: 3, maxRangePages: 2, maxPage: 19, fetchPage: (i) => page(ctx, i) });
  },
};

// ---------- 政策补贴宝 政策动态 ----------
// Nuxt page; list is server-rendered (dates YYYY.MM.DD). NOTE: as of 2026-09 the newest
// item is 2022-12-08, so this source is stale and normally yields nothing.
export const zcbtbao = {
  id: 'zcbtbao',
  name: '政策补贴宝',
  domain: 'policy',
  budget: 1,
  async fetch(ctx, start, end) {
    const r = await fetchText(ctx, 'https://zcbtbao.com/dynamic');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const items = [];
    // parse visible cards: title ... summary ... YYYY.MM.DD
    const text = r.text;
    for (const m of text.matchAll(/dynamicdetail\?infoId=(\d+)"([\s\S]{0,3000}?)(20\d{2}\.\d{2}\.\d{2})/g)) {
      const chunk = stripTags(m[2]).replace(/\|/g, ' ').trim();
      const title = (chunk.match(/【[^】]+】[^。，]{2,60}/) || [chunk.slice(0, 50)])[0].trim();
      items.push({ title, url: `https://zcbtbao.com/dynamicdetail?infoId=${m[1]}`, date: normDate(m[3]), source: '政策补贴宝' });
    }
    const newest = items.map((x) => x.date).sort().pop();
    return { items: items.filter((x) => inRange(x.date, start, end)), note: `newest item ${newest || 'n/a'} (source stale)` };
  },
};
