// Offline+online unit checks for src/custom.js:  node test/custom-unit.mjs
import { checkUrl, validateBody, parseFeed, looksLikeFeed, extractList, parseWechatArticle, parseDate, dateFromText, makeKeywordFilter, safeFetch } from '../src/custom.js';
import { Ctx } from '../src/util.js';
let fail = 0;
const t = (name, cond, extra = '') => { if (!cond) fail++; console.log(cond ? 'PASS' : 'FAIL', name, extra); };

// SSRF
for (const bad of ['http://127.0.0.1/', 'http://localhost/x', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://[::1]/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'file:///etc/passwd', 'ftp://a.com/', 'http://foo.internal/', 'http://intranet/', 'http://a.com:22/', 'http://user:pw@a.com/', 'https://x.workers.dev/', 'http://router.local/', 'javascript:alert(1)', ''])
  t('block ' + bad, !checkUrl(bad,'x.workers.dev').ok, checkUrl(bad,'x.workers.dev').error);
for (const good of ['https://www.ithome.com/rss/', 'http://www.solidot.org/index.rss', 'https://mp.weixin.qq.com/s/abc']) t('allow ' + good, checkUrl(good).ok);

// validation
const base = { start: '2026-09-01', end: '2026-09-29' };
t('empty sources', !!validateBody({ ...base, sources: [] }).error);
t('11 sources', !!validateBody({ ...base, sources: Array.from({ length: 11 }, (_, i) => ({ type: 'web', name: 'n' + i, url: 'https://a.com/' })) }).error);
t('10 sources ok', !validateBody({ ...base, sources: Array.from({ length: 10 }, (_, i) => ({ type: 'web', name: 'n' + i, url: 'https://a.com/' })) }).error);
t('bad type', !!validateBody({ ...base, sources: [{ type: 'bili', name: 'x', url: 'https://a.com/' }] }).error);
t('wechat non-mp link', !!validateBody({ ...base, sources: [{ type: 'wechat', name: 'x', links: ['https://evil.com/s/1'] }] }).error);
t('wechat needs something', !!validateBody({ ...base, sources: [{ type: 'wechat', name: 'x' }] }).error);
t('private url in source', !!validateBody({ ...base, sources: [{ type: 'web', name: 'x', url: 'http://192.168.0.1/' }] }).error);
t('bad domain -> custom', validateBody({ ...base, sources: [{ type: 'web', name: 'x', url: 'https://a.com/x', domain: 'zzz' }] }).sources[0].domain === 'custom');
t('bad body', !!validateBody('x').error && !!validateBody(null).error);
t('disabled skipped', validateBody({ ...base, sources: [{ type: 'web', name: 'x', url: 'https://a.com/x' }, { type: 'web', name: 'y', url: 'http://10.0.0.1', enabled: false }] }).sources.length === 1);

// dates
t('rfc822', parseDate('Mon, 28 Sep 2026 23:30:00 GMT') === '2026-09-29', parseDate('Mon, 28 Sep 2026 23:30:00 GMT'));
t('iso+8', parseDate('2026-09-28T23:30:00+08:00') === '2026-09-28');
t('epoch', parseDate('1757840583') === '2025-09-14');
t('cn date', dateFromText('发布时间：2026年9月3日', '2026-09-29') === '2026-09-03');
t('md date', dateFromText('09-27', '2026-09-29') === '2026-09-27');
t('rel', dateFromText('3小时前', '2026-09-29') === '2026-09-29' && dateFromText('2天前', '2026-09-29') === '2026-09-27');
t('kw', (() => { const f = makeKeywordFilter('储能,光伏 -广告'); return f({ title: '储能项目', desc: '' }) && !f({ title: '储能广告', desc: '' }) && !f({ title: '汽车', desc: '' }); })());

// feed parsers on synthetic
const rss = `<?xml version="1.0"?><rss><channel><title>T</title><item><title><![CDATA[你好 &amp; 世界]]></title><link>https://a.com/1</link><pubDate>Mon, 28 Sep 2026 10:00:00 +0800</pubDate><description><![CDATA[<p>desc</p>]]></description></item></channel></rss>`;
const f1 = parseFeed(rss, 'https://a.com/', '2026-09-29');
t('rss parse', f1.items.length === 1 && f1.items[0].date === '2026-09-28' && f1.items[0].desc === 'desc', JSON.stringify(f1.items[0]));
const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><title>标题一</title><link rel="alternate" href="/p/1"/><link rel="self" href="/x"/><updated>2026-09-27T01:00:00Z</updated><summary>s</summary></entry></feed>`;
const f2 = parseFeed(atom, 'https://a.com/', '2026-09-29');
t('atom parse', f2.items.length === 1 && f2.items[0].url === 'https://a.com/p/1' && f2.items[0].date === '2026-09-27', JSON.stringify(f2.items[0]));
t('looksLikeFeed', looksLikeFeed(rss) && looksLikeFeed(atom) && !looksLikeFeed('<html><body>x</body></html>'));

// html list synthetic
const html = `<ul><li><a href="/news/123456.html">国家能源局发布新型储能最新政策文件</a><span>2026-09-27</span></li><li><span>09-26</span><a href="/news/123455.html">光伏行业协会召开年度座谈会议</a></li><li><a href="/about">关于我们</a></li><li><a href="http://other.com/x/1234567.html">外站的一条很长的新闻标题在这里</a></li><li><a href="/news/99999.html" title="属性里的完整标题文字内容">更多</a></li></ul>`;
const l = extractList(html, 'https://a.com/list', '2026-09-29');
t('html list', l.length === 3 && l[0].date === '2026-09-27' && l[1].date === '2026-09-26', JSON.stringify(l));

// online
if (process.argv.includes('--online')) {
  const mk = () => new Ctx({ budget: 10, deadlineMs: 20000, fetchTimeoutMs: 9000 });
  const r = await safeFetch(mk(), 'https://www.ithome.com/rss/', { maxBytes: 1.5e6 });
  const f = parseFeed(r.text, r.finalUrl);
  t('ithome rss', f.kind === 'rss' && f.items.length > 20 && f.items[0].date, `${f.items.length} ${JSON.stringify(f.items[0])}`);
  const r2 = await safeFetch(mk(), 'https://www.ruanyifeng.com/blog/atom.xml', {});
  const f2 = parseFeed(r2.text, r2.finalUrl);
  t('atom real', f2.kind === 'atom' && f2.items.length >= 3, `${f2.items.length} ${JSON.stringify(f2.items[0])}`);
  for (const u of ['https://www.escn.com.cn/news/589.html', 'https://news.aibase.com/zh/news', 'https://www.ndrc.gov.cn/xxgk/zcfb/tz/']) {
    try {
      const rr = await safeFetch(mk(), u, { maxBytes: 1.5e6 });
      const ll = extractList(rr.text, rr.finalUrl);
      console.log(u, rr.status, rr.text.length, 'links', ll.length, 'dated', ll.filter((x) => x.date).length, JSON.stringify(ll.slice(0, 3)));
    } catch (e) { console.log(u, 'ERR', e.message); }
  }
  const wx = 'https://mp.weixin.qq.com/s/qiLgf8uWZSDyi7_VPgVMGQ';
  const rw = await safeFetch(mk(), wx, { maxBytes: 900000 });
  const a = parseWechatArticle(rw.text);
  t('wechat article', a.ok && a.date === '2025-09-14' && a.account, `${rw.status} trunc=${rw.truncated} len=${rw.text.length} ${JSON.stringify(a)}`);
  try { await safeFetch(mk(), 'http://127.0.0.1:8080/', {}); t('fetch localhost rejected', false); } catch (e) { t('fetch localhost rejected', true, e.message); }
}
console.log(fail ? `${fail} FAILED` : 'ALL PASS');
process.exit(fail ? 1 : 0);
