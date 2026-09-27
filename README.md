# 多领域新闻推送

静态网页：自定义新闻时间范围，手动点击「推送新闻」，按 AI / 国家政策 / 新能源输出简报。

## 本地预览

直接用浏览器打开 `index.html`，或：

```bash
python3 -m http.server 8080
```

## GitHub Pages

1. 仓库 Settings → Pages → Source 选 **GitHub Actions**
2. 推送到 `main` 后自动部署
3. 站点地址：`https://<user>.github.io/<repo>/`

## 更新数据

编辑 `data/news.json` 后推送即可；页面上点「推送新闻」会按所选日期过滤并渲染。

- `coverage: {start, end}` 标明数据覆盖区间；所选范围超出时页面会提示「数据仅覆盖 X ~ Y，超出部分暂无」。
- 每条 `date` 为原文真实发布日期（YYYY-MM-DD）；可选 `importance`（数字，越大越优先）用于每个领域默认只展示最重要的 10 条。
