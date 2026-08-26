# AllSessions 全面重设计开发计划

> 版本:2026-08-26 · 状态:已批准,待实施
> 决策依据:`PRODUCT.md` · 方向轮 seed key `5d8dd611`(impeccable direction round)
> 本文档面向实施者(人或 AI 工作模型),按阶段执行,每阶段有独立验收标准。

---

## 0. 决策记录(不可更改的前提)

用户已确认以下决策,实施过程中**不得擅自改变**:

| 决策项 | 结论 |
|---|---|
| 范围 | 整个应用(会话列表、对话详情、统计、工具/维护、设置) |
| 布局 | 彻底重做一套统一的新布局/信息架构,**所有主题共享** |
| 主题机制 | 5 个可切换主题,仅通过 design token + 少量局部样式差异换皮,不改 DOM 结构 |
| 主题清单 | ① 连续报表纸 Greenbar(默认) ② 现代 TUI ③ 品类标准 ④ 日式高密度 ⑤ 车库布帘 |
| 明暗 | 每个主题必须提供浅色与深色两种配色,支持跟随系统 |
| 技术约束 | 保持无框架 vanilla JS + CSS;不新增运行时依赖;保留全部现有功能与数据流 |

功能行为(过滤、搜索、导出、删除、维护、i18n、URL 状态同步、Tauri 事件)一律保留,只重写呈现层。

---

## 1. 现状盘点(实施者必读)

- 前端全部在 `public/`,由 Vite 构建,入口 `public/index.html`(约 1590 行,单页多视图)。
- 视图切换:`app.js` 的 `activateWorkspaceView(panel)`(约 2110 行处),通过 `data-sidebar-tab` 按钮与 `body.dataset.view` 切换 `list / stats / tools` 三个面板;设置是 `<dialog id="settings-dialog">`。
- 样式:`public/styles.css` 仅做 `@import`,实际样式在 `public/styles/` 六个文件:`foundation.css`(token + 基础)、`workspace.css`(列表+详情)、`analytics.css`(统计)、`maintenance.css`(工具)、`settings.css`、`responsive.css`。
- 现有 token 全部在 `foundation.css` 的 `:root`(teal 强调色体系),**没有**任何 `data-theme` / `prefers-color-scheme` 机制。
- 偏好持久化先例:语言用 `localStorage`(见 `i18n.js` 的 `LANG_KEY`),主题沿用同样机制。
- i18n:`data-i18n` 属性 + `i18n.js` 字典(zh/en 双语),新增 UI 文案必须同时补两种语言。
- 验证命令:`pnpm lint`(eslint)、`pnpm test`(node --test)、`pnpm format`、`pnpm web:dev`(浏览器可直接预览 UI,无 Tauri 后端时接口会失败,但布局/主题可看)、`pnpm dev`(完整 Tauri)。

---

## 2. 目标架构

### 2.1 主题系统

```
<html data-theme="greenbar" data-scheme="dark">
```

- `data-theme`:`greenbar | tui | standard | hdweb | blind`
- `data-scheme`:`light | dark`(由主题管理器根据用户选择或系统偏好实时写入,CSS 不直接用 `prefers-color-scheme` 查询,统一走属性选择器)
- 新文件 `public/theme-manager.js`:
  - `localStorage` 键:`allsessions_theme`(默认 `greenbar`)、`allsessions_scheme`(`light | dark | system`,默认 `system`)
  - 导出 `initTheme()`(在 `app.js` 顶部尽早调用,避免闪烁;更稳妥的做法是在 `index.html` `<head>` 内联一段 3 行的同步脚本先写属性,再由模块接管)
  - 导出 `setTheme(name)` / `setScheme(mode)`;`system` 模式监听 `matchMedia("(prefers-color-scheme: dark)")` 变化
- 设置对话框新增「外观」区块:主题选择(5 张小预览卡,各画一条该主题的色板)+ 明暗三选(浅色/深色/跟随系统)。顶栏加一个明暗快速切换按钮。
- 新目录 `public/styles/themes/`,每主题一个文件:`greenbar.css`、`tui.css`、`standard.css`、`hdweb.css`、`blind.css`,由 `styles.css` 统一 `@import`。

### 2.2 Token 契约(每个主题必须完整实现)

`foundation.css` 只保留**结构性** token(尺寸、层级、动效曲线)和 token 名清单;所有颜色/字体/材质 token 由主题文件在 `[data-theme="X"][data-scheme="light"]` 与 `[data-theme="X"][data-scheme="dark"]` 两个选择器下**完整**定义。任何组件样式只允许引用 token,禁止裸色值。

必须定义的 token(命名即契约,组件层按此引用):

```css
/* 画布与层 */
--bg  --surface  --surface-raised  --surface-sunken
--stripe-a  --stripe-b            /* 列表隔行底色;非条纹主题两值相同 */
/* 线 */
--line  --line-strong  --line-accent
/* 文本 */
--text  --text-secondary  --muted  --text-inverse
/* 强调与语义 */
--accent  --accent-strong  --accent-soft
--signal            /* 信号色:全应用唯一的破坏性/故障色,见 §3 纪律一 */
--signal-soft
--info --info-soft --warning --warning-soft --success --success-soft
/* 来源标识(六个数据源各一色,同一主题内深浅两版都要可读) */
--src-codex --src-claude --src-gemini --src-pi --src-kimi --src-opencode
/* 字体 */
--font-ui  --font-mono  --font-display        /* display 用于 banner 大数字 */
/* 形状与材质 */
--radius  --radius-small
--shadow-raised  --focus-ring
/* 结构(foundation 定义,主题可覆写少量) */
--rail-w  --list-w  --header-h  --density  /* density: 行高倍率,hdweb 等主题调小 */
```

对比度硬性要求:正文 `--text`/`--bg` ≥ 7:1,次级文本 ≥ 4.5:1,深浅两版都要过。

### 2.3 统一新布局(所有主题共享的信息架构)

彻底替换现有 toolbar + 三栏结构,目标布局:

```
┌──────────────────────────────────────────────────────────────┐
│ 作业头 Job Header(--header-h):品牌 · 视图切换 · 全局搜索      │
│ · 会话计数 · 明暗切换 · 设置                                    │
├────────┬───────────────────────────┬─────────────────────────┤
│ 索引栏  │ 会话列表(隔行条纹)         │ 详情面板                  │
│ rail   │ 列严格对齐:时间|来源|标题|  │ 对话 / 工具 / 原始事件     │
│ 来源树  │ 消息数|目录                │ 页签 + 检视器抽屉          │
│ 过滤器  │                           │                          │
│ 保存的  │                           │                          │
│ 过滤/  │                           │                          │
│ 标签   │                           │                          │
├────────┴───────────────────────────┴─────────────────────────┤
│ 状态栏 Status Bar:扫描健康 · 索引状态 · 键位提示 · 语言          │
└──────────────────────────────────────────────────────────────┘
```

要点:

1. **左侧索引栏(rail)**:来源(六个 agent,各带来源色标与计数)、过滤器(provider/日期/目录/标签)、显示开关(归档/隐藏/已移除/收藏)、保存的过滤器。取代现在塞在列表页里的过滤区。
2. **统计视图与工具视图**占据列表+详情的整个区域,索引栏保留(统计也吃过滤器)。
3. **常驻底部状态栏**(新增):左侧显示各来源扫描健康摘要(点击进诊断),中间显示当前过滤态,右侧键位提示(`⌘K 搜索`、`j/k 移动` 等)。
4. **键盘优先**:`⌘K` 聚焦搜索(已有),新增 `j/k` 或 `↑/↓` 在列表中移动、`Enter` 打开、`1/2/3` 切视图、`Esc` 关闭对话框。实现放 `app.js`,与主题无关。
5. 响应式:< 1320px 详情变抽屉(沿用现有 INSPECTOR_DRAWER_QUERY 思路),< 760px 单栏 + 底部导航。`responsive.css` 重写以适配新结构。
6. HTML 语义:`<header>` `<nav>` `<main>` `<aside>` `<footer>`;视图切换仍复用 `activateWorkspaceView`,但选择器改为新结构的 `data-view-panel`。

**类名规范**:新布局全部使用语义化 BEM 风格类(`.rail`, `.rail__group`, `.session-row`, `.session-row__source`, `.job-header`, `.status-bar`, `.detail-pane`...),组件样式写在 `workspace/analytics/maintenance/settings.css`(重写),只引用 token。

### 2.4 方向契约注释

`index.html` `<body>` 第一个子节点写入 HTML 注释(构建后必须保留,Phase 1 完成时用 `pnpm build && grep 5d8dd611 dist/index.html` 验证),五段各一两句:

```
THESIS / OWN-WORLD / STORY / FIRST VIEWPORT / FORM(含 seed key 5d8dd611)
FINISH: "unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance"
```

内容按 §4.1 Greenbar(默认主题)撰写。

---

## 3. 全局 UX 纪律(适用于全部 5 个主题,组件层实现一次)

这四条来自方向决策时吸收的挑战者纪律,是**跨主题的产品规则**,写进组件层而非主题层:

1. **信号色纪律**:`--signal` 是全应用唯一的破坏性/故障颜色。永久删除按钮、扫描故障态、回滚警告用它;任何装饰、图表、hover 效果**禁止**使用。各主题给它不同的具体色值(报表纸=图钉红,TUI=ANSI red,……),但语义唯一。
2. **Banner 大数字**:统计页的核心数字(会话总数、消息总数等)不用图表库风格的卡片,而是用 `--font-display`(各主题指定,greenbar 用等宽字加粗)以超大字号直接排印,标签小字随行。图表(趋势条形、分布)用纯 CSS/内联 SVG 实现,颜色只取 token。
3. **试印条删除预览**:永久删除确认对话框重做为"试印条"模式:提交前必须逐行列出将失去的内容(会话标题、来源、文件路径、消息数、时间跨度),用户看到清单后按钮才可用(保留现有 `deleteConfirmBtn` 的 disabled 逻辑并强化)。软删除不受此约束。
4. **单一对齐基准**:索引栏右缘是全应用唯一垂直基准线;列表列、详情内容、统计表格的左缘全部锁在同一 8px 栅格上。用 `--rail-w` 派生,禁止各视图自定横向 padding。

---

## 4. 主题规格(换皮层,每主题一个 CSS 文件)

每个主题文件结构统一:两个 token 块(light/dark)+ 一段不超过 ~150 行的局部覆写(材质细节,如条纹、边框风格、状态栏样式),**不改布局变量以外的结构**。

### 4.1 主题一:连续报表纸 Greenbar(`greenbar`,默认)

**世界**:1960–80 年代机房链式打印机的连续折叠报表纸。浅色 = 报表纸;深色 = 同一份记录的缩微胶片负片读法(同一世界,不是另一套皮)。

- **Light**:`--bg #f7f5ec`(纸白)、`--stripe-a #f7f5ec` / `--stripe-b #e6efe3`(经典淡绿条)、`--text #1c2420`、`--line #c9d2c5`、`--accent #2f6b4f`(章绿)、`--signal #c8361f`(图钉红)。
- **Dark(缩微胶片)**:`--bg #11151a`、`--stripe-a #11151a` / `--stripe-b #182029`、`--text #cfe0d5`(胶片银绿)、`--accent #6fbf94`、`--signal #ff5a3c`。
- **字体**:`--font-mono` 与 `--font-ui` 同为等宽栈(`"SF Mono", "Cascadia Mono", Consolas, monospace`);`--font-display` 同栈加粗。全应用等宽是该主题的核心身份。
- **材质细节(局部覆写)**:
  - 会话列表行使用 `--stripe-a/b` 隔行条纹(组件层已支持,其他主题两值相同即无条纹);
  - 索引栏左缘绘制"齿孔"装饰:`background: radial-gradient` 重复圆点列,宽约 14px;
  - 作业头顶部一条 `JOB ▸ ALLSESSIONS ▸ 504 SESSIONS` 风格的等宽小字行(即现有 meta 信息的呈现方式);
  - 分组标题(日期组)渲染成打印分隔行:`──── 2026-08-26 ────`(CSS border + 居中文字即可);
  - `--radius: 2px`,几乎直角;阴影极淡。
- **风险控制**:条纹对比必须低(ΔL < 6%),字号不小于 13px,避免复古玩具感;深色版不发绿光、不做扫描线特效。

### 4.2 主题二:现代 TUI(`tui`)

**世界**:lazygit / k9s / fzf 一代的终端面板语法。

- **Dark(主人格)**:`--bg #0d1117`、`--surface #161b22`、`--text #c9d1d9`、`--line #30363d`、`--accent #58a6ff`、`--signal #f85149`、来源色直接用 ANSI 亮色系(green/yellow/magenta/cyan/blue/red 微调)。
- **Light**:仿浅色终端主题(如 GitHub Light terminal):`--bg #ffffff`、`--surface #f6f8fa`、`--text #1f2328`、`--accent #0969da`、`--signal #cf222e`。
- **字体**:UI 用系统字,列表/详情/状态栏用等宽;`--font-display` 等宽。
- **材质细节**:
  - 面板边框用 1px 实线 + 面板标题嵌在边框上(`─ Sessions ─` 效果:标题元素负 margin 叠在 border 上);
  - 激活面板边框变 `--accent`(单线,不发光);
  - 状态栏反色(`--text-inverse` on `--accent` 底),酷似 tmux statusline;
  - 选中行:整行 `--accent-soft` 底 + 左侧 2px accent 竖线;
  - `--radius: 4px`。
- **风险控制**:不做 CRT 弧面/扫描线/辉光;它是"终端语法",不是"终端 cosplay"。

### 4.3 主题三:品类标准(`standard`)

**世界**:Linear / Raycast 水准的现代原生质感桌面应用,刻意常规、满级工艺。

- **Light**:`--bg #fafafa`、`--surface #ffffff`、`--text #0f1115`、`--line #e5e7eb`、`--accent #4f6ef7`、`--signal #dc2626`。
- **Dark**:`--bg #101114`、`--surface #17181c`、`--text #e6e7ea`、`--line #26282e`、`--accent #7a8cff`。
- **字体**:系统 UI 栈;代码等宽;`--font-display` 用系统字重 700。
- **材质细节**:`--radius: 10px`;柔和多层阴影;hover 浮起;半透明模糊顶栏(`backdrop-filter`,仅此主题);微妙的 150ms ease-out 过渡。
- **风险控制**:这是"标准答案"卡,目标是与 Linear 放在一起不丢人,不加任何怪癖。

### 4.4 主题四:日式高密度(`hdweb`)

**世界**:日本当代高密度资讯/电商站:细线框模块马赛克、红色小页签、每个像素都在工作。

- **Light(主人格)**:`--bg #ffffff`、`--surface #ffffff`、`--stripe-b #f4f4f4`、`--text #111111`、`--line #d9d9d9`、`--accent #d7000f`(注意:accent 与 signal 在此主题同为红,必须用形状区分——见下)、`--signal #d7000f`。
- **Dark**:`--bg #17171a`、`--surface #1e1e22`、`--text #e8e8e8`、`--line #3a3a40`、`--accent #ff4b57`。
- **字体**:系统字,`--density: 0.85`(行高压缩),基础字号 12.5px。
- **材质细节**:
  - 每个面板/分组带"页签头":左上角小色块标签(红底白字 10px),标题右侧塞满辅助信息;
  - 全部 1px 细线框,`--radius: 0`,无阴影;
  - 破坏性操作因 accent 同红,额外加 ⚠ 前缀 + 双线边框以示区别(组件层已有 signal 语义类,此主题覆写其形状);
  - 统计页在此主题下密度最高:模块间距 8px。
- **风险控制**:密度靠栅格纪律不靠拥挤;行高压缩但触达区仍 ≥ 28px。

### 4.5 主题五:车库布帘(`blind`)

**世界**:公交车库的卷动目的地布帘:瓶绿帆布、铬黄字模、整行步进。

- **Dark(主人格)**:`--bg #14100c`(车库暗)、`--surface #1d4a2f`(瓶绿布)、`--stripe-b #1a4229`、`--text #f4c400`(铬黄)、`--text-secondary #d9d4c0`、`--line #0e2a1a`、`--accent #f4c400`、`--signal #ff7b1c`(停摆橙,区别于黄)。
- **Light**:漂白帆布版:`--bg #efe8d8`、`--surface #e3dbc6`、`--text #1d3a28`、`--accent #8a6d00`。
- **字体**:UI 用系统窄体优先栈(`"Avenir Next Condensed", "Arial Narrow", system-ui`),列表标题大写、加字距;数据仍等宽。
- **材质细节**:
  - 列表行 = 布帘行:行高统一、行间 1px 深缝线;
  - 选中/切换动效:整行垂直步进一格 + 轻微过冲回弹(`transform: translateY`,120ms,`prefers-reduced-motion` 时瞬时切换)——这是该主题唯一的签名动效;
  - 故障态(扫描失败的来源)渲染为"停在半格":行内两半文字上下错位 3px(clip-path),配 `--signal`;
  - 索引栏左缘为冲孔索引带(圆孔列装饰,复用 greenbar 齿孔实现,换色)。
- **风险控制**:黄字只用于主文本层级,次级信息用米白,避免满屏荧光;动效只在行切换时发生。

---

## 5. 实施阶段(按顺序执行,每阶段独立可验收)

> 建议每阶段一个 commit/PR。任何阶段完成的定义都包含:`pnpm lint` 与 `pnpm test` 通过、`pnpm build` 成功、zh/en 两种语言下无缺失文案、深浅两 scheme 下无不可读组合。

### Phase 0 — 主题基础设施(不动布局)

1. 新建 `public/theme-manager.js`(§2.1);`index.html` `<head>` 加防闪烁内联脚本;`app.js` 引入并初始化。
2. `foundation.css` 重构:token 清单迁移为 §2.2 契约;把现有 teal 值临时挂到 `[data-theme="standard"]` 下保证过渡期可用。
3. 新建 `public/styles/themes/` 五个文件,先只写 token 块(材质细节后续阶段补)。
4. 设置对话框加「外观」区块(`settings-view.js` + `settings.css` + `index.html`),顶栏加明暗切换按钮;i18n 补 zh/en 文案(键名建议:`appearance`, `theme`, `themeGreenbar`, `themeTui`, `themeStandard`, `themeHdweb`, `themeBlind`, `schemeLight`, `schemeDark`, `schemeSystem`)。
5. **验收**:切主题/切明暗即时生效并持久化;`system` 模式跟随 macOS 外观实时变化;刷新无闪白。

### Phase 1 — 统一新布局重构(用 standard token 先行)

1. 重写 `index.html` 主结构为 §2.3 布局(作业头/索引栏/列表/详情/状态栏);写入 §2.4 方向契约注释。
2. 重写 `workspace.css` 与 `responsive.css`;`app.js` 中 `elements` 选择器、`activateWorkspaceView`、inspector 抽屉逻辑适配新 DOM。**功能零回归**:过滤、搜索、分页、选择、导出、软/硬删除、URL 同步、Tauri 事件全部可用。
3. 新增状态栏(扫描健康摘要 + 键位提示)与键盘导航(§2.3 第 4 条)。
4. 实施四条全局纪律中的 ①信号色语义类、③试印条删除预览、④单一对齐基准。
5. **验收**:1440px / 1280px / 760px 三档布局正确;键盘可完成"搜索→选中→打开→切页签→关闭"全流程;`grep 5d8dd611 dist/index.html` 命中;所有现有交互无回归。

### Phase 2 — 统计与工具视图重构

1. 重写 `analytics.css` + `stats-view.js` 渲染结构:Banner 大数字(纪律②)+ 纯 CSS/SVG 图表(趋势、Agent 分布、Provider、工作目录),全部只用 token。
2. 重写 `maintenance.css` 适配新布局;维护/回滚流程中的破坏性步骤统一接入信号色与试印条模式。
3. **验收**:统计页在 5 主题 token 下(此时仅 token 块)均可读;工具页破坏性操作有一致的 signal 呈现。

### Phase 3 — Greenbar 主题完成(默认)

1. 补全 `greenbar.css` 材质细节(§4.1:条纹、齿孔、打印分隔行、作业头小字行)。
2. 将默认主题切为 `greenbar`;`settings.css`、对话框、toast 等边角适配。
3. **验收**:浅/深两版逐视图走查(列表、详情、统计、工具、设置、删除对话框、空态、错误态);对比度达标;无裸色值(`grep -E '#[0-9a-fA-F]{3,8}' public/styles/*.css` 应只在 themes/ 与 foundation 出现)。

### Phase 4 — TUI 主题(§4.2)
### Phase 5 — 品类标准主题(§4.3,把 Phase 0 的临时 token 升级为正式规格)
### Phase 6 — 日式高密度主题(§4.4,含 `--density` 生效走查)
### Phase 7 — 车库布帘主题(§4.5,含步进动效与 reduced-motion 降级)

Phase 4–7 每个的验收 = Phase 3 的走查清单在该主题上重跑。

### Phase 8 — 收尾与质检

1. 全主题 × 全 scheme × 三档宽度截图矩阵(5×2×3),逐一目检。
2. 运行 impeccable 机械检测器并清理机械问题:
   `node ~/.agents/skills/impeccable/scripts/detect.mjs --json public/index.html public/styles`
3. 生成/更新 `DESIGN.md`(记录 token 契约、五主题规格、四条纪律、布局基准)。
4. `pnpm lint && pnpm test && pnpm build`;检查 `test/release-packaging.test.js` 等对 `public/` 文件清单有断言的测试是否需要更新(新增了 theme-manager.js 与 themes/*.css)。
5. i18n 全量走查(zh/en);a11y 走查:焦点环在 5 主题下可见、`aria-current`/`aria-label` 保留、`prefers-reduced-motion` 全局生效。

---

## 6. 风险与注意事项

- **最大风险在 Phase 1**:`app.js` 有约 2500 行,DOM 选择器散布各处(`elements` 表、`maintenance-view.js`、`conversation-view.js`、`settings-view.js` 都直接查询 DOM)。重构 HTML 时先全局搜索每个 `id`/class 引用再动手;保留全部现有 `id` 是最稳妥的策略(只改包裹结构与类名)。
- `conversation-view.js` / `markdown.js` 渲染的消息体样式在 `workspace.css`,重写时逐条迁移,勿丢 role/工具调用/thinking 折叠等状态样式。
- 现有 `styles.css` 带 `?v=` 缓存参数,重构后更新版本号。
- 不要动 `src-tauri/` 下任何东西;本次纯前端。
- 每个主题的"材质细节"覆写严格限制在视觉层;发现需要改 DOM 才能实现的效果,回到组件层加通用钩子(如 `data-group-divider`),让所有主题共享。

## 7. 交接给实施模型的开工指令模板

> 阅读 `docs/redesign-plan.zh-CN.md` 与 `PRODUCT.md`,执行 Phase N。只做该阶段清单内的事,完成后运行该阶段验收标准中的全部命令并报告结果。遇到与计划冲突的现状,停下来说明而不是自行改计划。
