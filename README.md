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

## 来源设置（自定义来源：网页 / 微信公众号）

页面中的「来源设置」面板（仅两类：**网页**、**微信公众号**）：每类下可添加/删除条目、开关启用，配置保存在浏览器 `localStorage`（键 `mnd-sources-v1`），最多 10 个。

* **添加方式（v6）**：点「＋ 添加网页来源 / ＋ 添加公众号来源」会**立即在列表末尾新增一行可编辑的来源**（名称框自动聚焦），可连续点击添加多行；在行内直接填写名称/网址/关键词/链接、选归入领域、开关启用——**每次输入自动保存**到 localStorage，行内实时显示校验结果（缺名称、无效/内网地址、非 mp.weixin.qq.com 链接、超过 10 条链接等）。未填完整的行不会参与抓取，推送时会提示「有 N 个来源没填完整，已跳过」。达到 10 个上限时点添加会在按钮旁显示明确提示。localStorage 中损坏/旧版本的数据会被容错读取（不会导致面板失效）。
* **网页**：名称 + 网址（文章列表页 或 RSS/Atom 订阅）+ 可选关键词过滤（逗号分隔，`-` 开头为排除）。
* **微信公众号**：名称 + ① RSS/Atom 地址（wechat2rss / RSSHub / feeddd 生成）或 ② 粘贴 `mp.weixin.qq.com/s/…` 文章链接（每行一条，≤10；Worker 读取标题、发布时间、公众号名、摘要）。
* 每个来源可「归入」**AI / 国家政策 / 新能源 / 自定义** 之一；新增「自定义」领域标签，只显示归入「自定义」的来源。归入 AI/政策/新能源的自定义来源与该领域内置来源一起展示。内置默认来源不变。
* 点「推送新闻」时，前端把已启用的自定义来源 `POST {WORKER_URL}/api/custom`（见 `worker/README.md`），结果走同一套摘要 / 利好利空分析，卡片上带 **网页 / 公众号** 徽标与你填的来源名。「自定义来源状态」折叠面板显示每个来源的成功/失败原因、解析条数。
* **必须能访问 Worker**：自定义来源由 Cloudflare Worker 代抓。**中国大陆手机网络通常无法访问 `*.workers.dev`**，此时页面明确提示，并显示**缓存在本机 localStorage**（键 `mnd-custom-cache-v1`，最近 12 组）的上次结果（卡片标「本机缓存」，注明缓存时间）；没有缓存则提示无结果。内置来源走 github.io 静态归档，不受影响。可用「清除本机缓存」按钮清空。
* 前端也做了同样的地址校验（http/https、不允许 IP/内网/workers.dev），Worker 再次校验并防 SSRF。
* 已知限制：微信公众号没有公开的历史文章列表，无法仅凭名称抓取；HTML 列表页靠启发式识别（链接+标题+日期），日期识别不出的条目会被忽略；反爬/需登录/JS 渲染的站点会在状态里报错。

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
