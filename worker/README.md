# cf-news-worker — 多领域新闻实时抓取 API (Cloudflare Worker)

`GET /api/news?start=YYYY-MM-DD&end=YYYY-MM-DD&domains=ai,policy,energy[&limit=5][&fresh=1][&probe=1]`

Live: **https://cf-news-worker.amosxch.workers.dev**  (e.g. `/api/news?start=2026-08-01&end=2026-08-05&domains=ai`)

For each requested domain the worker fetches every source in parallel (own sub-budget per source,
per-fetch timeout, global deadline), keeps items inside the date range, pre-ranks/diversifies them,
then makes **one LLM call per domain** to filter ads/fluff and produce `summary` (≤50字), `sentiment`
(利好/利空/中性), `analysis` (≤50字) and `importance` (1-3). Results are cached in Workers KV.

Response:
```json
{ "start": "...", "end": "...", "items": [{ "domain","title","summary","date","url","source",
  "sentiment","analysis","importance","live": true }],
  "sources": [{ "id","name","domain","status": "ok|error|partial|blocked|cached","count","requests","ms","note","error" }],
  "domain_meta": { "ai": { "cache": "hit|miss", "llm": {...}, "candidates": 69 } }, "subrequests": 19, "elapsed_ms": 18572 }
```
Item schema matches `data/news.json` of the static site, so the frontend merges them directly.

## Sources (feasibility checked 2026-09-28 from a datacenter IP)

| Domain | Source | Method | Reach back |
|---|---|---|---|
| AI | 钛媒体AGI | `api.tmtpost.com/v1/categories/multi_content/list?category_guid=6916385&offset&limit=50` (public web-client headers from the site's JS) — random access → interpolation search | whole column (6.5k posts, years) |
| AI | AIbase | list JSON API needs login (401); list HTML = newest 20 only. Article ids are sequential (~27/day) and each `/zh/news/{id}` embeds `__NUXT_DATA__` (title/description/createTime/pv) → interpolation search on id, then evenly sample ids in range | any date (tested 2025-07) |
| 政策 | 中国政府网 | `https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json` (1100 items) | 2020-01 → today, 1 request |
| 政策 | 财政部 | `zhengcefabu/index.htm`, `index_1.htm` … (20 pages) | ~2023; page 0 ≈ Jul→Sep 2026 |
| 政策 | 发改委 | `xxgk/zcfb/tz/index.html`, `index_N.html` | ~2025; page 0 ≈ May→Sep 2026 |
| 政策 | 政策补贴宝 | `/dynamic` SSR list | **stale – newest item 2022-12-08** |
| 新能源 | 中国储能网 | `/news/589.html`, `/news/589-N.html` (国内新闻, 20/page, ~1 page/day, 7.8k pages) → interpolation search | any date |
| 新能源 | 36氪 | HTML/`36kr.com/feed` behind bot challenge; `www.36kr.com/feed` OK but newest 30 only. History via site-search API `gateway.36kr.com/api/mis/nav/search/resultbytype` (keywords 储能/新能源, sort=date, pageSize=200, cursor) | ~5-6 weeks per request, deeper with more pages |
| 新能源 | 国家能源局 | datasource JSON behind the Vue lists: `/policy/ds_7290c8….json` (通知, 1000 items since 2015), `/news/ds_c9f95e….json` (局工作动态, 670 since 2018) | years, 2 requests |
| 新能源 | 北极星储能网 | all `*.bjx.com.cn` hosts return Aliyun WAF JS challenge | ✗ (skipped; `probe=1` to retry) |
| 新能源 | 国际能源网 | `chuneng.in-en.com` 403 / HTTP2 reset for non-browser clients | ✗ |
| 新能源 | 高工储能 gg-ii.com | expired TLS certificate / 503 | ✗ |

We do not solve JS/WAF challenges; blocked sites are reported with `status: "blocked"`.

## Limits & budget
* Free plan: 50 subrequests / invocation, 10 ms CPU (I/O wait not counted). Default `SUBREQUEST_BUDGET=46`, split
  across requested domains and then across sources (each source has a `budget`). The frontend calls one domain per
  request so each domain gets the full budget. Typical: ai ≈ 11-19, policy ≈ 4-6, energy ≈ 10-13 subrequests.
* HTML parsing is regex-based; the 1 MB NEA JSON is scanned with an early-exit regex instead of `JSON.parse`.
* Source phase deadline 22 s, per-fetch timeout 9 s, LLM timeout 25 s; failures give partial results + per-source status.

## Caching (KV `NEWS_KV`)
* `v2:res:{domain}:{start}:{end}:{limit}` final answer — 30 days for past ranges (3 h if a source failed), 30 min if the range includes today.
* `v2:day:{domain}:{date}` raw candidates per day (written when all non-blocked sources succeeded, range ≤31 days, past days only), so other ranges over the same days skip re-scraping.
* `v2:ana:{sha1(url)}` per-item AI analysis (90 days).
* `fresh=1` bypasses caches. If a domain yields <3 live items, items from `STATIC_JSON_URL` (the site's news.json) in range are topped up (`live:false`).

## LLM
Default: **Workers AI binding** `AI`, model `AI_MODEL` (default `@cf/qwen/qwen3-30b-a3b-fp8`, good Chinese + JSON, fast).
Override with any OpenAI-compatible API by setting the secret `LLM_API_KEY` (+ vars `LLM_BASE_URL`, `LLM_MODEL`):
DeepSeek `https://api.deepseek.com/v1` / `deepseek-chat`; 通义 `https://dashscope.aliyuncs.com/compatible-mode/v1` / `qwen-plus`; OpenAI `https://api.openai.com/v1` / `gpt-4o-mini`.
If neither is available items are returned with a truncated description as summary, `sentiment:"中性"`, empty analysis.
`?model=@cf/...` lets you try another Workers AI model (bypasses cache).

## Deploy
Requires wrangler 3 (Node 20) or 4 (Node ≥22). Auth: `wrangler login` (OAuth) **or** env `CLOUDFLARE_API_TOKEN`
(template "Edit Cloudflare Workers" + Workers KV Storage:Edit + Workers AI:Read/Edit) and `CLOUDFLARE_ACCOUNT_ID`.
```bash
cd /workspace/cf-news-worker
npm i -D wrangler@3                     # or use /workspace/wr/node_modules/.bin/wrangler
npx wrangler kv namespace create NEWS_KV   # put the id into wrangler.toml (already done: 01c19b33…)
npx wrangler deploy                        # first time: registers <subdomain>.workers.dev (done: amosxch)
# optional OpenAI-compatible override instead of Workers AI:
npx wrangler secret put LLM_API_KEY
npx wrangler tail                          # live logs (set DEBUG="1" in [vars] for per-fetch logs)
```
Local: `npx wrangler dev` (AI binding always runs remotely and needs login), or `node test/run-sources.mjs 2026-08-01 2026-08-05 [sourceId]` to test just the scrapers in Node.

## Files
* `src/index.js` router, CORS, orchestration, KV cache, static fallback
* `src/util.js` date helpers, fetch-with-timeout + subrequest budget (`Ctx`), `pagedSearch` interpolation search
* `src/sources/{ai,policy,energy}.js` one fetcher per site; `src/sources/index.js` registry
* `src/rank.js` heuristic scoring (domain keywords, source weight, ad/fluff/patent-filler penalties) + diversity
* `src/llm.js` Workers AI / OpenAI-compatible call, JSON extraction, validation
* `frontend.patch` diff of the static site (app.js / styles.css / index.html)
