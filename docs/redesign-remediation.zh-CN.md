# AllSessions 重设计补救指令(Remediation)

> 版本:2026-08-26 · 前置文档:`docs/redesign-plan.zh-CN.md`(总计划,规格以它为准)+ `PRODUCT.md`
> 背景:第一轮实施只完成了总计划的 **Phase 0(主题基础设施)**,其余阶段未做或只做了表皮。
> 用户验收结论:"除了颜色没什么变化"——完全属实,原因见 §1。
> 本文档是逐项可机械验收的执行指令。**每一项都附验证命令,验证不过=该项未完成,禁止口头声称完成。**

---

## 1. 审计结论(当前代码的真实状态)

已完成且保留(不要重做,不要破坏):

- `public/theme-manager.js` + `<head>` 防闪烁脚本 + `data-theme`/`data-scheme` 属性机制
- `public/styles/themes/*.css` 五个主题的 **token 块**(仅颜色/字体/圆角变量)
- 设置对话框「外观」区块、顶栏明暗切换、i18n 文案、`test/theme-manager.test.js`

未完成(即用户看不到变化的原因):

| # | 缺口 | 证据(当前 grep 结果) |
|---|---|---|
| G1 | 统一新布局完全没做:无作业头/索引栏/状态栏,index.html 结构未动 | `grep -cE 'job-header\|status-bar\|class="rail' public/index.html` → 0 |
| G2 | 方向契约注释缺失 | `grep -c 5d8dd611 public/index.html` → 0 |
| G3 | 隔行条纹 token 定义了但**没有任何组件引用**,条纹根本不渲染 | `grep -rc 'var(--stripe' public/styles/` → 全部 0 |
| G4 | 五个主题的材质细节层全部缺失(齿孔、打印分隔行、TUI 嵌边框标题/反色状态栏、日式页签头、布帘步进) | 主题文件各仅 ~85 行纯 token |
| G5 | 统计页 Banner 大数字未做 | `grep -c 'font-display' public/styles/analytics.css` → 0 |
| G6 | 试印条删除预览未做 | `grep -cE 'test-strip\|试印' public/app.js public/index.html` → 0 |
| G7 | 键盘导航未做(j/k、1/2/3、Enter) | `grep -nE 'ArrowDown' public/app.js` → 无 |
| G8 | 信号色纪律只做了 `--danger: var(--signal)` 别名,未审查语义 | 见 foundation.css:15 |

---

## 2. 执行顺序

按 R1 → R5 顺序执行,每个 R 一个独立提交。规格细节(色值、材质、行为)一律回查总计划对应小节,本文只列任务与验收。

---

## R1 — 统一新布局重构(对应总计划 Phase 1,优先级最高)

这是"看起来没变化"的根源。完成后无论哪个主题,应用的骨架都是新的。

### 任务

1. 按总计划 §2.3 重写 `public/index.html` 主结构:
   - `<header class="job-header">`:品牌、视图切换(list/stats/tools)、全局搜索、会话计数、明暗切换、设置;
   - `<aside class="rail">`:来源树(六个 agent,带 `--src-*` 色标与计数)、过滤器(provider/日期/目录/标签)、显示开关、保存的过滤器——把现有散在列表页的过滤控件**移进来**,保留所有元素 `id` 不变;
   - `<main>` 内:会话列表(`.session-row` 网格化列对齐:时间|来源|标题|消息数|目录)+ 详情面板;stats/tools 面板占据 main 整区;
   - `<footer class="status-bar">`:扫描健康摘要(数据来自现有 diagnostics)、当前过滤态、键位提示、语言。
2. `<body>` 第一个子节点写入方向契约注释(五段:THESIS/OWN-WORLD/STORY/FIRST VIEWPORT/FORM 含 seed key `5d8dd611`,加 FINISH 行,内容按总计划 §2.4/§4.1 撰写)。
3. 重写 `public/styles/workspace.css` 与 `responsive.css` 适配新结构;列表行底色必须使用 `var(--stripe-a)/var(--stripe-b)` 隔行(修复 G3;非条纹主题两值相同,自然无条纹)。
4. 适配 `app.js` 的 `elements` 表与 `activateWorkspaceView`;**策略:保留全部现有 id,只改包裹结构与类名**,`conversation-view.js`/`maintenance-view.js`/`settings-view.js` 里的 DOM 查询逐一核对。
5. 键盘导航(修复 G7):`↑/↓`(及 j/k)移动列表选中、`Enter` 打开、`1/2/3` 切视图、`Esc` 关对话框;输入框聚焦时不劫持。
6. 单一对齐基准:所有视图内容左缘锁定 `--rail-w` 派生的同一条基准线(总计划 §3 纪律四)。
7. 新增 UI 文案全部走 i18n(zh + en 双语)。

### 验收(全部必须通过)

```bash
grep -cE 'job-header|status-bar|class="rail' public/index.html   # ≥ 3
grep -c 5d8dd611 public/index.html                               # ≥ 1
pnpm build && grep -c 5d8dd611 dist/index.html                   # ≥ 1
grep -rc 'var(--stripe' public/styles/workspace.css              # ≥ 2
pnpm lint && pnpm test
```

人工走查:`pnpm web:dev` 下 1440/1280/760px 三档布局正确;过滤、搜索、分页、多选导出、软/硬删除、URL 同步全部无回归;键盘流程"⌘K→输入→↓↓→Enter→Esc"可完成。

---

## R2 — 全局纪律补齐(对应 Phase 1 遗留 + Phase 2)

1. **试印条删除预览**(修复 G6,总计划 §3 纪律三):永久删除确认对话框重做——提交前逐行列出将失去的内容(标题、来源、文件路径、消息数、时间跨度),清单渲染完成后确认按钮才解禁;新增类名含 `test-strip`;维护/回滚视图的破坏性步骤同样接入。
2. **信号色审查**(修复 G8):全项目搜索 `--danger`/`--signal` 的每一处使用,凡属"破坏性操作或故障态"之外的用途(装饰、普通强调)改用其他语义 token;完成后在本文档 §4 登记一份使用清单。
3. **Banner 大数字**(修复 G5,总计划 §3 纪律二):重写统计页顶部指标为 `--font-display` 超大字号直排(clamp(40px, 6vw, 72px) 级别),标签小字随行;图表全部纯 CSS/内联 SVG,只用 token。

### 验收

```bash
grep -cE 'test-strip' public/index.html public/app.js            # 各 ≥ 1
grep -c 'var(--font-display' public/styles/analytics.css         # ≥ 1
pnpm lint && pnpm test
```

人工走查:永久删除一个会话时先出现内容清单;统计页大数字在 5 主题下均正常。

---

## R3 — Greenbar 材质层(默认主题成型,对应 Phase 3)

在 `themes/greenbar.css` 追加材质覆写(规格:总计划 §4.1),此时 R1 的条纹已生效,再加:

1. 索引栏左缘齿孔装饰(repeating radial-gradient 圆点列,宽 ~14px,深浅两 scheme 都要);
2. 日期分组标题渲染为打印分隔行 `──── 2026-08-26 ────`(组件层加通用钩子类,主题层覆写样式);
3. 作业头下沿一条等宽小字 `JOB ▸ ALLSESSIONS ▸ N SESSIONS` 信息行(复用现有计数数据);
4. 深色 = 缩微胶片负片:核对 §4.1 Dark 色值,禁止辉光/扫描线。
5. 确认 `theme-manager.js` 默认主题为 `greenbar`。

### 验收

```bash
grep -cE 'radial-gradient' public/styles/themes/greenbar.css     # ≥ 1
node -e "const s=require('fs').readFileSync('public/theme-manager.js','utf8');process.exit(/greenbar/.test(s)?0:1)"
```

人工走查清单(浅+深各一遍):列表条纹可见但不刺眼、齿孔、分隔行、详情、统计、工具、设置、删除对话框、空态、错误态;正文对比度 ≥ 7:1。

---

## R4 — 其余四主题材质层(对应 Phase 4–7)

每主题在自己的 css 文件追加 ≤150 行材质覆写,规格严格按总计划对应小节:

- **tui**(§4.2):面板标题嵌入边框(`─ Sessions ─`,负 margin 叠 border)、激活面板 accent 边框、状态栏反色(tmux 式)、选中行左缘 2px 竖线。验收:`grep -c 'status-bar' public/styles/themes/tui.css` ≥ 1。
- **standard**(§4.3):多层柔和阴影、`backdrop-filter` 顶栏(仅此主题)、150ms 过渡。验收:`grep -c 'backdrop-filter' public/styles/themes/standard.css` ≥ 1。
- **hdweb**(§4.4):模块页签头(红底白字小标签)、全 1px 细线框 + `--radius:0`、`--density:0.85` 生效走查、破坏性操作 ⚠+双线边框。验收:`grep -c 'density' public/styles/themes/hdweb.css` ≥ 1。
- **blind**(§4.5):行切换整行垂直步进+过冲动效(120ms,`prefers-reduced-motion` 降级为瞬时)、故障来源"半格"错位态、冲孔索引带(复用齿孔实现换色)。验收:`grep -cE 'prefers-reduced-motion' public/styles/themes/blind.css` ≥ 1。

需要 DOM 钩子才能实现的效果(如页签头、分组分隔行),一律在组件层加通用 data 属性/类,主题层只写样式——禁止在主题 css 里依赖某主题专属 DOM。

---

## R5 — 收尾质检(对应 Phase 8)

1. 5 主题 × 2 scheme × 3 宽度(1440/1280/760)截图矩阵,逐一目检并修复。
2. `node ~/.agents/skills/impeccable/scripts/detect.mjs --json public/index.html public/styles` 清理机械问题。
3. 生成 `DESIGN.md`:token 契约、五主题规格、四纪律、布局基准(以最终代码为准,不是抄计划)。
4. 更新 `test/layout.test.js` 断言新结构;检查 `test/release-packaging.test.js` 文件清单。
5. `pnpm lint && pnpm test && pnpm build`;zh/en 全量走查;焦点环 5 主题可见性走查。

---

## 3. 禁止事项

- 禁止只改 token/颜色就声称某阶段完成——本轮返工的起因就是这个。
- 禁止跳过验证命令;禁止修改验证命令来迁就实现。
- 禁止改 `src-tauri/`;禁止引入新运行时依赖;禁止删除现有元素 `id`。
- 与总计划冲突时停下说明,不得自行改规格。

## 4. 信号色使用登记(R2 完成时由实施者填写)

| 文件:行 | 用途 | 判定(保留/改用其他 token) |
|---|---|---|
| (待填) | | |
