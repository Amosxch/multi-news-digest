// User-defined sources: POST /api/custom
// Two categories only: "web" (article list page or RSS/Atom/JSON feed) and
// "wechat" (RSS/Atom bridge feed such as wechat2rss / RSSHub / feeddd, or pasted mp.weixin.qq.com article links).
import { BudgetError, decodeEntities, stripTags, absUrl, msToYmd, todayCst, normDate, dayNum, dayStr, isYmd, UA } from './util.js';

export const CUSTOM_DOMAINS = ['ai', 'policy', 'energy', 'custom'];
export const LIMITS = { maxSources: 10, maxLinks: 10, maxBody: 24000, maxUrl: 500, maxName: 30, maxKeyword: 80, maxItemsPerSource: 60, maxFeedBytes: 1_500_000, maxHtmlBytes: 1_500_000, maxWechatBytes: 900_000 };

/* ------------------------------------------------------------------ SSRF guard */
const BAD_SUFFIX = /\.(local|localhost|internal|intranet|lan|home|corp|localdomain|test|invalid|example)$/i;
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443', '1200']); // 1200 = default RSSHub port

/** Returns {ok:true,url:URL} or {ok:false,error}. Pure string checks; Cloudflare's network additionally refuses private egress. */
export function checkUrl(raw, selfHost) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: '地址为空' };
  if (raw.length > LIMITS.maxUrl) return { ok: false, error: '地址过长' };
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: '不是有效的网址' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '只允许 http/https 地址' };
  if (u.username || u.password) return { ok: false, error: '地址不能包含账号密码' };
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return { ok: false, error: '缺少主机名' };
  if (h.startsWith('[') || h.includes(':')) return { ok: false, error: '不允许 IPv6 地址' };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return { ok: false, error: '不允许 IP 地址（请使用域名）' };
  if (/^(0x[0-9a-f]+|\d+)$/i.test(h)) return { ok: false, error: '不允许 IP 地址（请使用域名）' };
  if (!h.includes('.')) return { ok: false, error: '不允许内网主机名' };
  if (h === 'localhost' || BAD_SUFFIX.test(h)) return { ok: false, error: '不允许内网/保留域名' };
  if (selfHost && (h === selfHost.toLowerCase() || h.endsWith('.workers.dev'))) return { ok: false, error: '不允许抓取 Workers 自身/workers.dev' };
  if (!ALLOWED_PORTS.has(u.port)) return { ok: false, error: `不允许的端口 ${u.port}` };
  u.hash = '';
  return { ok: true, url: u };
}
const isWechatArticle = (u) => u.hostname === 'mp.weixin.qq.com' && (u.pathname.startsWith('/s') || u.pathname.startsWith('/mp/'));

/* ------------------------------------------------------------------ validation */
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Validate request body. Returns {error} or {start,end,sources,limit,fresh}. */
export function validateBody(b, selfHost, maxDays = 92) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: '请求体必须是 JSON 对象' };
  if (!isYmd(b.start) || !isYmd(b.end)) return { error: 'start/end 必须是 YYYY-MM-DD' };
  if (b.start > b.end) return { error: 'start 不能晚于 end' };
  if (dayNum(b.end) - dayNum(b.start) + 1 > maxDays) return { error: `日期范围过长（最多 ${maxDays} 天）` };
  if (!Array.isArray(b.sources) || !b.sources.length) return { error: 'sources 不能为空' };
  if (b.sources.length > LIMITS.maxSources) return { error: `最多 ${LIMITS.maxSources} 个来源` };
  const sources = [];
  const errors = [];
  b.sources.forEach((s, idx) => {
    const tag = `来源#${idx + 1}`;
    if (!s || typeof s !== 'object') return errors.push(`${tag}: 格式错误`);
    if (s.enabled === false) return;
    const type = s.type;
    if (type !== 'web' && type !== 'wechat') return errors.push(`${tag}: type 只能是 web 或 wechat`);
    const name = clean(s.name, LIMITS.maxName);
    const domain = CUSTOM_DOMAINS.includes(s.domain) ? s.domain : 'custom';
    const id = clean(s.id, 40).replace(/[^\w-]/g, '') || `s${idx}`;
    const rec = { id, name, type, domain, keyword: clean(s.keyword, LIMITS.maxKeyword) };
    if (type === 'web') {
      if (!name) return errors.push(`${tag}: 需要名称`);
      const c = checkUrl(s.url, selfHost);
      if (!c.ok) return errors.push(`${tag}(${name}): ${c.error}`);
      rec.url = c.url.toString();
    } else {
      const links = Array.isArray(s.links) ? s.links : [];
      if (links.length > LIMITS.maxLinks) return errors.push(`${tag}(${name}): 文章链接最多 ${LIMITS.maxLinks} 条`);
      if (s.url) {
        const c = checkUrl(s.url, selfHost);
        if (!c.ok) return errors.push(`${tag}(${name}): ${c.error}`);
        rec.url = c.url.toString();
      }
      rec.links = [];
      for (const l of links) {
        const c = checkUrl(l, selfHost);
        if (!c.ok) return errors.push(`${tag}(${name}): 文章链接无效：${c.error}`);
        if (!isWechatArticle(c.url)) return errors.push(`${tag}(${name}): 文章链接必须是 mp.weixin.qq.com 的文章`);
        if (!rec.links.includes(c.url.toString())) rec.links.push(c.url.toString());
      }
      if (!rec.url && !rec.links.length) return errors.push(`${tag}(${name}): 需要 RSS/Atom 地址或至少一条文章链接`);
    }
    sources.push(rec);
  });
  if (errors.length) return { error: errors.slice(0, 5).join('；') };
  if (!sources.length) return { error: '没有启用的来源' };
  const limit = Math.max(1, Math.min(12, parseInt(b.limit || '8', 10) || 8));
  return { start: b.start, end: b.end, sources, limit, fresh: b.fresh === true };
}

/* ------------------------------------------------------------------ safe fetch */
async function readLimited(res, maxBytes) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) {
    const t = await res.text();
    return { bytes: new TextEncoder().encode(t.slice(0, maxBytes)), truncated: t.length > maxBytes };
  }
  const chunks = [];
  let n = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    if (n >= maxBytes) {
      truncated = true;
      try {
        await reader.cancel();
      } catch {}
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(n, maxBytes));
  let o = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, bytes.length - o);
    bytes.set(c.subarray(0, take), o);
    o += take;
    if (o >= bytes.length) break;
  }
  return { bytes, truncated };
}
function decodeBytes(bytes, contentType) {
  let label = ((contentType || '').match(/charset=([\w-]+)/i) || [])[1];
  if (!label) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 3000));
    label = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || head.match(/<\?xml[^>]+encoding=["']([\w-]+)/i) || [])[1];
  }
  try {
    return new TextDecoder(label || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** GET with manual redirect handling (each hop re-validated and counted as a subrequest), timeout, and size cap. */
export async function safeFetch(ctx, rawUrl, { maxBytes = 1_000_000, selfHost, accept } = {}) {
  let url = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    const c = checkUrl(url, selfHost);
    if (!c.ok) throw new Error(`地址被拒绝：${c.error}`);
    ctx.take();
    const left = ctx.timeLeft();
    if (left < 800) throw new Error('deadline reached');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort('timeout'), Math.min(ctx.fetchTimeoutMs, left));
    try {
      const res = await fetch(c.url.toString(), {
        headers: { 'User-Agent': UA, Accept: accept || 'application/rss+xml,application/atom+xml,application/xml,text/xml,text/html;q=0.9,*/*;q=0.5', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6' },
        redirect: 'manual',
        signal: ac.signal,
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('Location')) {
        url = new URL(res.headers.get('Location'), c.url).toString();
        try {
          await res.body?.cancel();
        } catch {}
        continue;
      }
      const { bytes, truncated } = await readLimited(res, maxBytes);
      const ct = res.headers.get('Content-Type') || '';
      return { status: res.status, ok: res.ok, text: decodeBytes(bytes, ct), truncated, contentType: ct, finalUrl: c.url.toString() };
    } catch (e) {
      if (e instanceof BudgetError) throw e;
      throw new Error(`抓取失败（${String(e && e.message ? e.message : e).slice(0, 60)}）`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('重定向次数过多');
}

/* ------------------------------------------------------------------ dates */
/** Any feed/HTML date string -> YYYY-MM-DD in Asia/Shanghai (or null). */
export function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  if (/^\d{9,10}$/.test(s)) return msToYmd(Number(s) * 1000);
  if (/^\d{13}$/.test(s)) return msToYmd(Number(s));
  const hasZone = /(Z|[+-]\d{2}:?\d{2}|GMT|UTC|[A-Z]{3,4})\s*$/.test(s) && !/^\d{4}-\d{2}-\d{2}\s*$/.test(s);
  if (hasZone) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return msToYmd(t);
  }
  const nd = normDate(s);
  if (nd) return nd;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : msToYmd(t);
}
const sane = (d, today) => (d && d >= '2000-01-01' && dayNum(d) <= dayNum(today) + 1 ? d : null);

/** Find a publication date inside a short text snippet (list-page context). */
export function dateFromText(txt, today = todayCst()) {
  if (!txt) return null;
  let m = txt.match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (m) return sane(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, today);
  const yr = Number(today.slice(0, 4));
  const fromMd = (mo, da) => {
    mo = Number(mo);
    da = Number(da);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    let d = `${yr}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
    if (d > dayStr(dayNum(today) + 1)) d = `${yr - 1}-${d.slice(5)}`;
    return d;
  };
  m = txt.match(/(?<![\d.])(\d{1,2})月(\d{1,2})日/);
  if (m) return fromMd(m[1], m[2]);
  m = txt.match(/(?<![\d.\-/])(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])(?![\d\-/.])/);
  if (m) return fromMd(m[1], m[2]);
  if (/(\d+)\s*(分钟|小时|秒)前|刚刚|今天/.test(txt)) return today;
  m = txt.match(/(\d+)\s*天前/);
  if (m && Number(m[1]) < 60) return dayStr(dayNum(today) - Number(m[1]));
  if (/昨天/.test(txt)) return dayStr(dayNum(today) - 1);
  if (/前天/.test(txt)) return dayStr(dayNum(today) - 2);
  return null;
}
function dateFromUrl(u, today) {
  let m = u.match(/(?:^|[/_\-t=])(20\d{2})[/-]?(0[1-9]|1[0-2])[/-]?(0[1-9]|[12]\d|3[01])(?!\d)/);
  if (m) return sane(`${m[1]}-${m[2]}-${m[3]}`, today);
  m = u.match(/\/(20\d{2})(0[1-9]|1[0-2])\/t?(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
  if (m) return sane(`${m[3]}-${m[4]}-${m[5]}`, today);
  return null;
}

/* ------------------------------------------------------------------ feeds */
const tagText = (block, names) => {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
    if (m) {
      let v = m[1].trim();
      const cd = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
      v = cd ? cd[1] : decodeEntities(v);
      if (v) return v;
    }
  }
  return '';
};

export function looksLikeFeed(text, contentType = '') {
  const head = text.slice(0, 1500).toLowerCase();
  if (/<rss[\s>]|<feed[\s>]|<rdf:rdf[\s>]/.test(head)) return true;
  if (/^\s*\{/.test(text) && /jsonfeed\.org/.test(text.slice(0, 400))) return true;
  if (/xml/.test(contentType) && /<(item|entry)[\s>]/.test(text.slice(0, 6000).toLowerCase())) return true;
  return false;
}

export function parseFeed(text, baseUrl, today = todayCst()) {
  const items = [];
  let title = '';
  if (/^\s*\{/.test(text)) {
    const j = JSON.parse(text);
    title = j.title || '';
    for (const it of (j.items || []).slice(0, 200)) {
      const url = absUrl(it.url || it.external_url || '', baseUrl);
      items.push({ title: stripTags(it.title || ''), url, date: sane(parseDate(it.date_published || it.date_modified), today), desc: stripTags(it.summary || it.content_text || it.content_html || '').slice(0, 300) });
    }
    return { kind: 'jsonfeed', title, items: items.filter((x) => x.title && x.url) };
  }
  const atom = /<feed[\s>]/i.test(text.slice(0, 1500));
  title = stripTags(tagText(text.slice(0, 20000).replace(/<(item|entry)[\s>][\s\S]*/i, ''), ['title']));
  const re = atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<(item|rdf:li)[\s>][\s\S]*?<\/\1>|<item[\s>][\s\S]*?<\/item>/gi;
  const blocks = text.match(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const b of blocks.slice(0, 200)) {
    let link = '';
    if (atom) {
      const links = [...b.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
      const alt = links.find((a) => /rel=["']alternate["']/i.test(a)) || links.find((a) => !/rel=/i.test(a)) || links[0] || '';
      link = (alt.match(/href=["']([^"']+)["']/i) || [])[1] || '';
      link = decodeEntities(link);
    } else {
      link = tagText(b, ['link']).trim() || tagText(b, ['guid']).trim();
      if (!/^https?:/i.test(link)) link = (b.match(/<link[^>]+href=["']([^"']+)["']/i) || [])[1] || link;
    }
    const url = absUrl(decodeEntities(link).trim(), baseUrl);
    const t = stripTags(tagText(b, ['title']));
    const dRaw = tagText(b, ['pubDate', 'published', 'updated', 'dc:date', 'date', 'lastBuildDate']);
    const descRaw = tagText(b, ['description', 'summary', 'content:encoded', 'content']);
    const desc = stripTags(descRaw).slice(0, 300);
    items.push({ title: t, url, date: sane(parseDate(dRaw), today), desc });
  }
  void re;
  return { kind: atom ? 'atom' : 'rss', title, items: items.filter((x) => x.title && x.url && /^https?:/.test(x.url)) };
}

/* ------------------------------------------------------------------ HTML list page heuristics */
const NAV = /^(首页|主页|更多|查看更多|more|登录|注册|下一页|上一页|尾页|首页|返回|关于我们|联系我们|网站地图|隐私|版权|订阅|rss|english|next|prev|previous|上页|下页|末页|详情|了解更多|点击查看|阅读全文|阅读原文)$/i;
const BAD_PATH = /\/(tag|tags|category|categories|author|authors|user|users|login|logout|register|search|topic|special|about|contact|help|feed|rss|page)(\/|$)|(^|[/?&])(page|p|pn|pageno)=\d+|\/(index|list)[_-]?\d*\.s?html?$|\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|rar|doc|docx|xls|xlsx|css|js|mp4|mp3)(\?|$)/i;
const cjkCount = (s) => (s.match(/[\u3400-\u9fff]/g) || []).length;
const ARTICLE_LIKE = /\d{5,}|\.s?html?$|\/(p|a|article|articles|news|post|posts|detail|content|info|story|doc|blog)\/[^/?#]+|[?&](id|aid|newsid|articleid|tid)=\d+|\/20\d{2}[/-]?\d{2}/i;

function baseDomain(h) {
  const p = h.split('.');
  if (p.length <= 2) return h;
  const last2 = p.slice(-2).join('.');
  if (/^(com|net|org|gov|edu|ac)\.[a-z]{2}$/.test(last2)) return p.slice(-3).join('.');
  return last2;
}
const attr = (attrs, name) => {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : '';
};

/** Extract {title,url,date|null,desc} from an HTML list page. */
export function extractList(html, pageUrl, today = todayCst()) {
  const page = new URL(pageUrl);
  const pageBase = baseDomain(page.hostname);
  const out = [];
  const seenUrl = new Set();
  const seenTitle = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  let n = 0;
  while ((m = re.exec(html)) && n++ < 1500) {
    const attrs = m[1];
    const href = attr(attrs, 'href');
    if (!href || /^(javascript:|#|mailto:|tel:)/i.test(href)) continue;
    const abs = absUrl(href, pageUrl);
    if (!abs || !/^https?:/.test(abs)) continue;
    let u;
    try {
      u = new URL(abs);
    } catch {
      continue;
    }
    u.hash = '';
    if (baseDomain(u.hostname) !== pageBase) continue;
    if (u.pathname === '/' || u.pathname === '') continue;
    const clean_ = u.toString();
    if (clean_ === page.toString() || BAD_PATH.test(u.pathname + u.search)) continue;
    const innerHtml = m[2].replace(/<(?:script|style|svg)[\s\S]*?<\/(?:script|style|svg)>/gi, '');
    const frags = decodeEntities(innerHtml.replace(/<[^>]*>/g, '\u0001')).split('\u0001').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const tAttr = attr(attrs, 'title');
    const isTitle = (x) => cjkCount(x) >= 6 || (x.length >= 20 && x.split(/\s+/).length >= 3);
    let title = '';
    let desc = '';
    let innerDate = null;
    if (frags.length <= 1) {
      let inner = frags[0] || '';
      const dm = inner.match(/(20\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}日?|(?<![\d.])\d{1,2}-\d{1,2}(?![\d.]))\s*$/) || inner.match(/^\s*(20\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}日?|(?<![\d.])\d{1,2}-\d{1,2}(?![\d.]))/);
      if (dm) {
        innerDate = dateFromText(dm[1], today);
        inner = inner.replace(dm[1], '').trim();
      }
      title = inner;
      if (cjkCount(title) < 6 && tAttr && tAttr.length > title.length) title = tAttr.trim();
    } else {
      // card-style anchor: several text fragments (title, summary, "刚刚 6.6K" ...)
      const ti = frags.findIndex(isTitle);
      if (ti >= 0) {
        title = frags[ti];
        const rest = frags.filter((_, i) => i !== ti);
        desc = rest.filter(isTitle).join(' ').slice(0, 200);
        for (const r of rest) {
          if (isTitle(r) && !/^\d{1,2}[-/.]\d{1,2}$/.test(r)) continue;
          const d = dateFromText(r, today);
          if (d) {
            innerDate = d;
            break;
          }
        }
      }
    }
    title = title.replace(/\s+/g, ' ').trim();
    if (NAV.test(title)) continue;
    if (!isTitle(title)) continue;
    if (title.length > 200) title = title.slice(0, 200);
    if (seenUrl.has(clean_) || seenTitle.has(title)) continue;
    // date: inside anchor > url > following text > preceding text (same list item)
    const end = m.index + m[0].length;
    let after = html.slice(end, end + 400);
    const cut = after.search(/<\/(?:li|tr|dd|dl|article|ul|ol|tbody)>|<a\b|<h[1-6]\b/i);
    if (cut >= 0) after = after.slice(0, cut);
    let before = html.slice(Math.max(0, m.index - 700), m.index);
    let bcut = -1;
    const re2 = /<(?:li|tr|dd|dt|article)\b[^>]*>|<\/a>/gi;
    let mm;
    while ((mm = re2.exec(before))) bcut = mm.index;
    if (bcut >= 0) before = before.slice(bcut);
    const bt = stripTags(before);
    const em = bt.match(/(?<!\d)(\d{1,2})\s+(20\d{2})\s*[-./]\s*(\d{1,2})\s*$/); // "<em>29</em><span>2026-09</span>" calendar blocks
    const emDate = em ? sane(`${em[2]}-${em[3].padStart(2, '0')}-${em[1].padStart(2, '0')}`, today) : null;
    const date = innerDate || dateFromUrl(clean_, today) || dateFromText(stripTags(after), today) || emDate || dateFromText(bt, today);
    if (!date && !(ARTICLE_LIKE.test(u.pathname + u.search) && cjkCount(title) >= 8)) continue;
    seenUrl.add(clean_);
    seenTitle.add(title);
    out.push({ title, url: clean_, date, desc });
  }
  // when most links carry dates, undated ones are almost certainly navigation/category links
  const dated = out.filter((x) => x.date).length;
  return dated >= 5 ? out.filter((x) => x.date) : out;
}

/** Look for the page's own publication date (article detail page). */
export function articleDate(html, today = todayCst()) {
  const metas = [/property=["']article:published_time["'][^>]*content=["']([^"']+)/i, /content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i, /name=["'](?:pubdate|publishdate|PubDate|publish_date|weibo:article:create_at|og:updated_time)["'][^>]*content=["']([^"']+)/i, /"datePublished"\s*:\s*"([^"]+)"/i, /<time[^>]+datetime=["']([^"']+)/i];
  for (const r of metas) {
    const m = html.match(r);
    const d = m && sane(parseDate(m[1]), today);
    if (d) return d;
  }
  const body = stripTags(html.slice(0, 60000)).slice(0, 3000);
  return sane(dateFromText(body.match(/(20\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2})/)?.[1] || '', today), today);
}
const metaContent = (html, key) => {
  const r1 = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i');
  const r2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i');
  const m = html.match(r1) || html.match(r2);
  return m ? decodeEntities(m[1]).trim() : '';
};
export function discoverFeed(html, pageUrl) {
  const m = html.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i);
  if (!m) return null;
  const href = attr(m[0], 'href');
  return href ? absUrl(href, pageUrl) : null;
}

/* ------------------------------------------------------------------ WeChat article */
const between = (s, a, b, from = 0) => {
  const i = s.indexOf(a, from);
  if (i < 0) return '';
  const j = s.indexOf(b, i + a.length);
  return j < 0 ? '' : s.slice(i + a.length, j);
};
const jsUnescape = (s) => s.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(["'\\/])/g, '$1');

/** Parse a public mp.weixin.qq.com article page. Returns {ok,title,date,account,desc} or {ok:false,reason}. */
export function parseWechatArticle(html, today = todayCst()) {
  const blocked = [
    [/该内容已被发布者删除|内容已被删除|The content has been deleted/, '文章已被发布者删除'],
    [/此内容因违规无法查看|该内容因违规/, '文章因违规无法查看'],
    [/参数错误|链接已过期|链接失效/, '文章链接无效或已过期'],
    [/环境异常|完成验证后即可继续访问|weui-msg[^>]*>[^<]*验证/, '微信要求验证（环境异常/验证码），Worker 出口被限制'],
    [/该公众号已迁移|已被封禁|被投诉并经审核/, '公众号/文章不可访问'],
  ];
  const head = html.slice(0, 900000);
  let title = metaContent(head, 'og:title') || jsUnescape(between(head, "msg_title = '", "'")) || jsUnescape(between(head, 'var msg_title = "', '"'));
  if (!title) {
    for (const [re, why] of blocked) if (re.test(head.slice(0, 200000))) return { ok: false, reason: why };
    return { ok: false, reason: '未识别到文章标题（可能不是公开文章或被限制访问）' };
  }
  let account = '';
  const nk = head.match(/nick_name\s*[:=]\s*(?:JsDecode\()?['"]([^'"]{1,60})['"]/) || head.match(/var nickname\s*=\s*(?:htmlDecode\()?["']([^"']{1,60})["']/) || head.match(/profile_nickname[^>]*>([^<]{1,60})</);
  if (nk) account = decodeEntities(jsUnescape(nk[1])).trim();
  if (!account) account = metaContent(head, 'og:article:author');
  let date = null;
  const ct = head.match(/var ct\s*=\s*["']?(\d{9,10})/) || head.match(/\bcreateTimestamp\s*[:=]\s*['"]?(\d{9,10})/) || head.match(/\bcreate_time\s*[:=]\s*['"](\d{9,10})['"]/);
  if (ct) date = msToYmd(Number(ct[1]) * 1000);
  if (!date) {
    const ds = head.match(/(?:create_time|createTime|oriCreateTime)\s*[:=]\s*['"](\d{4}-\d{2}-\d{2})/);
    if (ds) date = ds[1];
  }
  if (!date) {
    const pt = head.match(/id="publish_time"[^>]*>([^<]+)</);
    if (pt) date = dateFromText(pt[1], today);
  }
  let desc = metaContent(head, 'og:description') || metaContent(head, 'description');
  if (!desc || desc === title) {
    const i = head.indexOf('id="js_content"');
    if (i >= 0) desc = stripTags(head.slice(i, i + 12000).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')).slice(0, 220);
  }
  return { ok: true, title: stripTags(title), date: sane(date, today), account, desc: (desc || '').slice(0, 300) };
}

/* ------------------------------------------------------------------ keyword filter */
export function makeKeywordFilter(kw) {
  const parts = String(kw || '').split(/[,，;；、|\s]+/).map((s) => s.trim()).filter(Boolean);
  const inc = parts.filter((p) => !p.startsWith('-') && !p.startsWith('！')).map((p) => p.toLowerCase());
  const exc = parts.filter((p) => p.startsWith('-') || p.startsWith('！')).map((p) => p.slice(1).toLowerCase()).filter(Boolean);
  if (!inc.length && !exc.length) return null;
  return (it) => {
    const t = `${it.title} ${it.desc || ''}`.toLowerCase();
    if (exc.some((k) => t.includes(k))) return false;
    return !inc.length || inc.some((k) => t.includes(k));
  };
}

/* ------------------------------------------------------------------ per-source fetch */
async function fetchWeb(ctx, src, start, end, selfHost, budgetDetail) {
  const st = { feed: null, note: '' };
  const today = todayCst();
  const r = await safeFetch(ctx, src.url, { maxBytes: LIMITS.maxFeedBytes, selfHost });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  let items;
  if (looksLikeFeed(r.text, r.contentType)) {
    const f = parseFeed(r.text, r.finalUrl, today);
    st.feed = f.kind;
    items = f.items;
    st.note = `${f.kind.toUpperCase()} 订阅，共解析 ${items.length} 条`;
  } else {
    if (/(验证码|访问验证|安全验证|Access Denied|Just a moment|captcha)/i.test(r.text.slice(0, 20000)) && r.text.length < 30000) throw new Error('目标站点拦截了 Worker 出口（反爬/验证）');
    items = extractList(r.text, r.finalUrl, today);
    st.feed = 'html';
    const dated = items.filter((x) => x.date).length;
    st.note = `HTML 列表页，识别 ${items.length} 个链接，其中 ${dated} 个带日期`;
    if (dated < 3) {
      const fu = discoverFeed(r.text, r.finalUrl);
      if (fu && ctx.remaining() > 1) {
        try {
          const rf = await safeFetch(ctx, fu, { maxBytes: LIMITS.maxFeedBytes, selfHost });
          if (rf.ok && looksLikeFeed(rf.text, rf.contentType)) {
            const f = parseFeed(rf.text, rf.finalUrl, today);
            if (f.items.filter((x) => x.date).length > dated) {
              items = f.items;
              st.feed = f.kind;
              st.note = `页面日期识别不足，已改用页面声明的订阅 ${fu}（${items.length} 条）`;
            }
          }
        } catch {}
      }
    }
    // undated candidates: peek at detail pages (small budget)
    const undated = items.filter((x) => !x.date);
    if (st.feed === 'html' && undated.length && budgetDetail > 0) {
      const pick = undated.slice(0, Math.min(budgetDetail, Math.max(0, ctx.remaining())));
      await Promise.allSettled(
        pick.map(async (it) => {
          try {
            const d = await safeFetch(ctx, it.url, { maxBytes: 200_000, selfHost, accept: 'text/html,*/*;q=0.5' });
            if (d.ok) {
              it.date = articleDate(d.text, today);
              it.desc = it.desc || metaContent(d.text, 'description').slice(0, 200);
            }
          } catch {}
        })
      );
      st.note += `；补抓 ${pick.length} 篇详情页取日期`;
    }
  }
  const total = items.length;
  const f = makeKeywordFilter(src.keyword);
  if (f) items = items.filter(f);
  st.total = total;
  st.afterKeyword = items.length;
  return { items, ...st };
}

async function fetchWechat(ctx, src, start, end, selfHost) {
  const today = todayCst();
  const items = [];
  const notes = [];
  const links = [];
  let feed = null;
  let total = 0;
  if (src.url) {
    const r = await safeFetch(ctx, src.url, { maxBytes: LIMITS.maxFeedBytes, selfHost });
    if (!r.ok) throw new Error(`订阅地址 HTTP ${r.status}`);
    if (!looksLikeFeed(r.text, r.contentType)) throw new Error('该地址不是 RSS/Atom 订阅（微信公众号没有公开的历史文章列表，需使用 wechat2rss / RSSHub / feeddd 等生成的订阅地址）');
    const f = parseFeed(r.text, r.finalUrl, today);
    feed = f.kind;
    total += f.items.length;
    items.push(...f.items);
    notes.push(`${f.kind.toUpperCase()} 订阅解析 ${f.items.length} 条`);
  }
  if (src.links && src.links.length) {
    let ok = 0;
    await Promise.all(
      src.links.map(async (link) => {
        const rec = { url: link, ok: false };
        links.push(rec);
        try {
          const r = await safeFetch(ctx, link, { maxBytes: LIMITS.maxWechatBytes, selfHost, accept: 'text/html,*/*;q=0.5' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const a = parseWechatArticle(r.text, today);
          if (!a.ok) throw new Error(a.reason);
          rec.ok = true;
          rec.title = a.title;
          rec.date = a.date;
          rec.account = a.account;
          ok++;
          total++;
          items.push({ title: a.title, url: link, date: a.date, desc: a.desc, account: a.account });
        } catch (e) {
          rec.error = String(e.message || e).slice(0, 120);
        }
      })
    );
    notes.push(`文章链接 ${ok}/${src.links.length} 篇解析成功`);
  }
  const f = makeKeywordFilter(src.keyword);
  const kept = f ? items.filter(f) : items;
  return { items: kept, feed: feed || 'wechat-article', note: notes.join('；'), total, links };
}

/** Budget planning: how many subrequests each source wants. */
function want(src) {
  if (src.type === 'web') return 5; // list + optional feed discovery + up to 3 detail pages
  return (src.url ? 1 : 0) + (src.links ? src.links.length : 0);
}

/** Fetch all sources in parallel with per-source child budgets. Returns {items, statuses}. */
export async function gatherCustom(ctx, sources, start, end, selfHost) {
  const today = todayCst();
  const wants = sources.map(want);
  const sum = wants.reduce((a, b) => a + b, 0);
  const avail = Math.max(1, ctx.remaining());
  const scale = Math.min(1, avail / Math.max(1, sum));
  const items = [];
  const statuses = [];
  await Promise.all(
    sources.map(async (src, i) => {
      const alloc = Math.max(1, Math.floor(wants[i] * scale));
      const st = { id: src.id, name: src.name, kind: src.type, domain: src.domain, status: 'ok', count: 0, total: 0, requests: 0, ms: 0 };
      statuses[i] = st;
      const child = ctx.child(alloc);
      const t0 = Date.now();
      try {
        const r =
          src.type === 'web'
            ? await fetchWeb(child, src, start, end, selfHost, Math.max(0, Math.min(3, alloc - 1)))
            : await fetchWechat(child, src, start, end, selfHost);
        const inR = r.items.filter((x) => x.date && x.date >= start && x.date <= end && x.date <= today);
        const noDate = r.items.filter((x) => !x.date).length;
        st.total = r.total ?? r.items.length;
        st.count = Math.min(inR.length, LIMITS.maxItemsPerSource);
        st.feed = r.feed;
        st.note = r.note || '';
        if (r.afterKeyword !== undefined && r.afterKeyword !== st.total) st.note += `；关键词过滤后剩 ${r.afterKeyword} 条`;
        if (noDate) st.note += `；${noDate} 条未识别到日期已忽略`;
        if (r.links) {
          st.links = r.links;
          const outR = r.items.filter((x) => x.date && !(x.date >= start && x.date <= end)).length;
          if (outR) st.note += `；${outR} 篇不在所选日期范围内`;
        }
        if (!inR.length) st.status = r.items.length || st.total ? 'empty' : 'empty';
        if (r.links && r.links.length && r.links.every((l) => !l.ok) && !src.url) {
          st.status = 'error';
          st.error = r.links[0].error;
        }
        const name = src.name || (r.items.find((x) => x.account) || {}).account || '公众号';
        st.name = name;
        inR
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, LIMITS.maxItemsPerSource)
          .forEach((x) => items.push({ title: x.title, url: x.url, date: x.date, desc: (x.desc || '').slice(0, 160), source: name, kind: src.type, domain: src.domain, sid: src.id }));
      } catch (e) {
        st.status = e instanceof BudgetError ? 'partial' : 'error';
        st.error = String(e.message || e).slice(0, 200);
      } finally {
        st.requests = child.used;
        st.ms = Date.now() - t0;
      }
    })
  );
  return { items, statuses };
}
