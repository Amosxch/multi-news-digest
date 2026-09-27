import { fetchJson, fetchText, msToYmd, pagedSearch, inRange, stripTags } from '../util.js';

// ---------- 钛媒体 AGI (column 6916385) ----------
// Public JSON API used by the tmtpost.com web front-end (api.tmtpost.com). It needs the
// web client's static "app-version/app-key/app-secret" headers that are shipped in the
// site's public JS bundle (not a user credential). offset/limit give random access, so an
// interpolation search reaches any date (tested back to 2024; 6.5k posts in the column).
const TMT_HEADERS = {
  'app-version': 'web1.0',
  'app-key': '2015042403',
  'app-secret': 'F3x47g39Wc4M96nwA28T',
  device: 'pc',
  Referer: 'https://www.tmtpost.com/',
};
export const tmtpost = {
  id: 'tmtpost',
  name: '钛媒体AGI',
  domain: 'ai',
  budget: 9,
  async fetch(ctx, start, end) {
    const LIMIT = 50;
    const r = await pagedSearch({
      start,
      end,
      maxProbes: 5,
      maxRangePages: 3,
      fetchPage: async (i) => {
        const url = `https://api.tmtpost.com/v1/categories/multi_content/list?category_guid=6916385&subtype=post&limit=${LIMIT}&offset=${i * LIMIT}&fields=summary`;
        const j = await fetchJson(ctx, url, { headers: TMT_HEADERS });
        if (j.result !== 'ok' && !Array.isArray(j.data)) throw new Error('tmtpost api: ' + JSON.stringify(j.errors || '').slice(0, 80));
        return (j.data || []).map((x) => ({
          title: stripTags(x.title),
          url: x.short_url || x.share_link || `https://www.tmtpost.com/${x.guid}.html`,
          date: msToYmd(Number(x.time_published) * 1000),
          desc: stripTags(x.summary || ''),
          pv: Number(x.number_of_reads) || 0,
          source: '钛媒体AGI',
        }));
      },
    });
    return r;
  },
};

// ---------- AIbase 基地 ----------
// news.aibase.com list JSON API requires login (401), list HTML only shows newest ~20 and
// ignores ?page. But article ids are sequential (~27/day) and each detail page embeds
// __NUXT_DATA__ with title/description/createTime/pv, so we interpolation-search the id
// space (one detail page = one "page"), then sample ids evenly inside the range.
function parseNuxt(html) {
  const m = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
function nuxtArticles(arr) {
  const out = [];
  if (!Array.isArray(arr)) return out;
  for (const o of arr) {
    if (o && typeof o === 'object' && !Array.isArray(o) && 'createTime' in o && 'title' in o) {
      const g = (k) => (k in o ? arr[o[k]] : undefined);
      out.push({ title: g('title'), desc: g('description') || g('summary') || '', createTime: g('createTime'), pv: g('pv'), oid: g('oid') });
    }
  }
  return out;
}
export const aibase = {
  id: 'aibase',
  name: 'Aibase基地',
  domain: 'ai',
  budget: 14,
  async fetch(ctx, start, end) {
    const list = await fetchText(ctx, 'https://news.aibase.com/zh/news');
    if (!list.ok) throw new Error(`list HTTP ${list.status}`);
    const listArts = nuxtArticles(parseNuxt(list.text)).filter((a) => a.oid && a.createTime);
    const ids = [...list.text.matchAll(/href="\/zh\/news\/(\d+)"/g)].map((m) => Number(m[1]));
    const newest = Math.max(...ids, ...listArts.map((a) => Number(a.oid)));
    if (!Number.isFinite(newest)) throw new Error('cannot find newest article id');
    const items = listArts.map((a) => ({
      title: stripTags(a.title),
      url: `https://news.aibase.com/zh/news/${a.oid}`,
      date: String(a.createTime).slice(0, 10),
      desc: stripTags(a.desc),
      pv: Number(a.pv) || 0,
      source: 'Aibase基地',
    }));
    const STRIDE = 1;
    const detail = async (id) => {
      for (let k = 0; k < 2; k++) {
        const r = await fetchText(ctx, `https://news.aibase.com/zh/news/${id - k}`);
        if (r.status === 404) continue; // daily-report ids etc.
        const a = nuxtArticles(parseNuxt(r.text))[0];
        if (a && a.createTime)
          return [{ title: stripTags(a.title), url: `https://news.aibase.com/zh/news/${id - k}`, date: String(a.createTime).slice(0, 10), desc: stripTags(a.desc), pv: Number(a.pv) || 0, source: 'Aibase基地' }];
      }
      return [];
    };
    // "page" 0 = list page, page i = article id newest - i*STRIDE
    const r = await pagedSearch({
      start,
      end,
      maxProbes: 6,
      maxRangePages: 6,
      maxPage: newest - 1,
      initialDpp: 1 / 27,
      fetchPage: async (i) => (i === 0 ? items : detail(newest - i * STRIDE)),
    });
    return r;
  },
};
