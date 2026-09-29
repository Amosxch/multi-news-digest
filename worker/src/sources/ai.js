import { fetchJson, fetchText, msToYmd, pagedSearch, inRange, stripTags, dayNum } from '../util.js';

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
      maxRangePages: Math.max(3, ctx.budget - 6),
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
// Known (id, date) calibration points; the live newest id from the list page is added at runtime.
const AIBASE_ANCHORS = [
  [20000, '2025-07-28'],
  [24000, '2025-12-25'],
  [27500, '2026-04-27'],
  [29000, '2026-06-18'],
  [30500, '2026-08-20'],
];
const AIBASE_RATE = 27; // ids per day (approx.)

export const aibase = {
  id: 'aibase',
  name: 'Aibase基地',
  domain: 'ai',
  budget: 18,
  async fetch(ctx, start, end) {
    const list = await fetchText(ctx, 'https://news.aibase.com/zh/news');
    if (!list.ok) throw new Error(`list HTTP ${list.status}`);
    const listArts = nuxtArticles(parseNuxt(list.text)).filter((a) => a.oid && a.createTime);
    const toItem = (a, id) => ({
      title: stripTags(a.title),
      url: `https://news.aibase.com/zh/news/${id}`,
      date: String(a.createTime).slice(0, 10),
      desc: stripTags(a.desc),
      pv: Number(a.pv) || 0,
      source: 'Aibase基地',
    });
    const found = new Map(); // id -> item
    for (const a of listArts) found.set(Number(a.oid), toItem(a, a.oid));
    const newest = Math.max(...[...list.text.matchAll(/href="\/zh\/news\/(\d+)"/g)].map((m) => Number(m[1])), ...found.keys());
    if (!Number.isFinite(newest)) throw new Error('cannot find newest article id');

    // anchors as [id, dayNum]
    const anchors = AIBASE_ANCHORS.map(([id, d]) => [id, dayNum(d)]);
    for (const [id, it] of found) anchors.push([id, dayNum(it.date)]);
    const idAt = (day) => {
      const pts = [...anchors].sort((a, b) => a[0] - b[0]);
      // piecewise-linear interpolation on (day -> id); extrapolate with AIBASE_RATE
      if (day <= pts[0][1]) return Math.round(pts[0][0] - (pts[0][1] - day) * AIBASE_RATE);
      for (let i = 1; i < pts.length; i++) {
        const [i0, d0] = pts[i - 1];
        const [i1, d1] = pts[i];
        if (day <= d1) return d1 === d0 ? i1 : Math.round(i0 + ((day - d0) / (d1 - d0)) * (i1 - i0));
      }
      const [il, dl] = pts[pts.length - 1];
      return Math.round(il + (day - dl) * AIBASE_RATE);
    };
    // fetch one article; daily-report ids 404 -> step down to the neighbour
    const probe = async (id) => {
      for (let k = 0; k < 3; k++) {
        const cur = id - k;
        if (cur < 1 || cur > newest) return null;
        if (found.has(cur)) return found.get(cur);
        if (ctx.remaining() < 1) return null;
        const r = await fetchText(ctx, `https://news.aibase.com/zh/news/${cur}`);
        if (r.status === 404) continue;
        const a = nuxtArticles(parseNuxt(r.text))[0];
        if (a && a.createTime) {
          const it = toItem(a, cur);
          found.set(cur, it);
          anchors.push([cur, dayNum(it.date)]);
          return it;
        }
      }
      return null;
    };
    const S = dayNum(start);
    const E = dayNum(end);
    let lo = Math.max(1, idAt(S - 0.1));
    let hi = Math.min(newest, idAt(E + 1) - 1);
    let note = '';
    if (hi < lo) return { items: [], note: 'range after newest article' };
    // two refinement rounds: probe both ends in parallel, re-interpolate with the new anchors
    for (let round = 0; round < 2; round++) {
      const [pl, ph] = await Promise.all([probe(lo), hi > lo ? probe(hi) : null]);
      const okLo = !pl || (dayNum(pl.date) < S && dayNum(pl.date) >= S - 1) || (lo === 1);
      const okHi = !ph || hi === newest || (dayNum(ph.date) <= E && dayNum(ph.date) >= E - 1);
      if (okLo && okHi) break;
      lo = Math.max(1, idAt(S - 0.1));
      hi = Math.min(newest, idAt(E + 1) - 1);
      if (hi < lo) break;
    }
    // evenly sample the id range with the remaining budget (each sample ~1.1 requests)
    const k = Math.max(0, Math.min(45, Math.floor((ctx.remaining() - 1) / 1.15)));
    const ids = new Set();
    for (let i = 0; i < k; i++) ids.add(Math.round(lo + ((i + 0.5) * (hi - lo)) / Math.max(1, k)));
    await Promise.allSettled([...ids].filter((id) => !found.has(id)).map((id) => probe(id)));
    note = `ids ${lo}..${hi}, sampled ${ids.size}`;
    const items = [...found.values()].filter((x) => inRange(x.date, start, end));
    return { items, note };
  },
};
