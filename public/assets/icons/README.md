# 界面图标

界面 SVG 图标取自 [Phosphor Icons](https://phosphoricons.com)（MIT，许可证正文见本目录 `LICENSE-phosphor.txt`），path 数据直接内联，不随本目录放置独立文件：

- `public/index.html` 的静态 `<svg>`：`viewBox="0 0 256 256"` + `fill="currentColor"`；有激活态的控件同时携带 `.icon-regular` / `.icon-fill` 两条 path，由 `components.css` 按 `.active` / `aria-pressed` 切换。
- `public/app/icons.js` 的 `ICON_PATHS`：同一批 path 数据供动态节点使用，经 `createIcon(name, { weight, size })` 构建。
- CSS 内嵌的 mask / background data-uri（搜索放大镜、下拉 caret）同样使用 Phosphor 几何。

新增图标时从 phosphor-icons/core 取对应权重的 `d` 数据，两边保持同步；agent 品牌图标仍在 `assets/agents/`，不在此列。
