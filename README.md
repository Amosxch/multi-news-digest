# 多领域新闻推送

静态网页（GitHub Pages）：选择任意日期范围与领域，点击「推送新闻」，得到 AI / 国家政策 / 新能源简报
（标题+链接、≤50字摘要、日期、来源、利好/利空/中性 + ≤50字分析）。

## 数据从哪来（按需抓取 + 静态归档兜底）

1. **静态归档（离线兜底）**：`data/archive/YYYY-MM.json`（2026-01-01 起，按月分文件）+ `data/index.json`（月份清单、覆盖区间、`updated_at`）。
   页面只加载与所选区间相交的月份文件，因此手机（国内网络，`*.workers.dev` 不可达）也能查看任意历史区间。
   `data/news.json` 是人工精选条目，合并时**优先**（按 URL 去重）。
2. **按需实时抓取**：点击「推送新闻」时，页面会先立即显示静态归档，再向 Cloudflare Worker
   （`WORKER_URL`，见 `app.js` 顶部）请求：
   - 归档覆盖区间**之外**的日期（必须靠实时服务，失败会明确提示「实时抓取服务连接失败…」）；
   - 归档内**最近 3 天**（`LIVE_TAIL_DAYS`，尽量取最新；失败则静默沿用归档，并提示「实时服务当前不可用，已显示静态归档数据，数据更新于 …」）。
3. 页面加载时会 ping `WORKER_URL/api/ping` 并显示是否可达；不可达时不再等待超时，直接回退归档。

> 没有定时任务。归档只在需要时手动补充（见下），不会每 30 分钟自动更新。

## 目录

| 路径 | 说明 |
|---|---|
| `index.html` `app.js` `styles.css` | 前端 |
| `version.json` | 版本号；页面加载时对比 `APP_VERSION`，不一致则带 `?v=` 重新加载一次（避免 Pages 缓存） |
| `data/index.json` | 归档索引：`months[]`、`coverage{start,end}`、`updated_at` |
| `data/archive/YYYY-MM.json` | 月度归档（`{month, items[]}`，条目结构同 news.json，`live:false`） |
| `data/news.json` | 精选条目（优先） |
| `data/archive-report.json` | 归档构建报告：缺口、各来源每月条数 |
| `scripts/build-archive.mjs` | 分块（默认 4 天）调用 Worker 抓取历史，原始结果落盘 |
| `scripts/assemble-archive.mjs` | 合并原始块 + 精选，写月度文件与 index.json |
| `scripts/refresh.mjs` | 拉取最近 N 天并合并进当月文件（`--dry` 只演练） |
| `.github/workflows/pages.yml` | push 到 main 自动部署 Pages |
| `.github/workflows/refresh-news.yml` | **仅手动触发**：刷新最近 N 天 → 提交 → 部署 Pages |

## 手动补充归档

- GitHub：Actions → “Refresh archive & deploy Pages (manual)” → Run workflow（可选 `days`、`force_deploy`）。
  无需任何 secrets（Worker 地址公开）。无变化时不会提交，也不会失败。
- 本地：
  ```bash
  node scripts/refresh.mjs --days 3 --dry            # 演练，不写文件
  node scripts/refresh.mjs --days 3                  # 写入 data/
  node scripts/build-archive.mjs --start 2026-01-01 --end 2026-09-29   # 全量重建原始块（约 20 分钟）
  node scripts/assemble-archive.mjs --start 2026-01-01 --end 2026-09-29
  ```

## 本地预览

```bash
python3 -m http.server 8080
```
