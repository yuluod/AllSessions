import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

async function readProjectFile(relativePath) {
  const source = await fs.readFile(path.join(rootDir, relativePath), "utf8");
  if (relativePath !== "public/styles.css") return source;

  const imports = Array.from(
    source.matchAll(/@import url\("(.+?)"\);/g),
    (match) => match[1]
  );
  const imported = await Promise.all(
    imports.map((file) => {
      const resolved = path.join(path.dirname(relativePath), file);
      return fs.readFile(path.join(rootDir, resolved), "utf8");
    })
  );
  return [source, ...imported].join("\n");
}

test("首页具备工作台式布局骨架", async () => {
  const html = await readProjectFile("public/index.html");

  assert.match(html, /class="toolbar"/);
  assert.match(html, /class="sidebar-left"/);
  assert.match(html, /class="filter-bar"/);
  assert.match(html, /class="detail-shell"/);
  assert.match(html, /class="props-panel"/);
});

test("全局导航位于顶部并将次要筛选渐进折叠", async () => {
  const html = await readProjectFile("public/index.html");

  assert.match(
    html,
    /<header class="toolbar">[\s\S]*class="sidebar-tabs workspace-tabs"/
  );
  assert.match(html, /<details id="sidebar-filters" class="sidebar-filters">/);
  assert.match(html, /<details class="project-nav">/);
  assert.doesNotMatch(html, /<details class="project-nav" open>/);
  assert.match(html, /<details class="visibility-panel">/);
});

test("工作区切换使用普通导航语义并支持键盘切换", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");

  assert.match(html, /class="sidebar-tab active"[\s\S]*aria-current="page"/);
  assert.doesNotMatch(
    html,
    /class="sidebar-tab active"[\s\S]{0,160}role="tab"/
  );
  assert.match(source, /tab\.setAttribute\("aria-current", "page"\)/);
  assert.match(source, /if \(event\.key === "Home"\) nextIndex = 0/);
  assert.match(
    source,
    /if \(event\.key === "End"\) nextIndex = workspaceTabs\.length - 1/
  );
});

test("首次数据读取失败会显示可重试状态，静态交互在读取前完成绑定", async () => {
  const source = await readProjectFile("public/app.js");
  const html = await readProjectFile("public/index.html");

  assert.match(source, /function renderWorkspaceLoadFailure\(error\)/);
  assert.match(source, /state\.workspaceLoadError = error/);
  assert.match(
    source,
    /if \(state\.workspaceLoadError\) \{[\s\S]*renderWorkspaceLoadFailure\(state\.workspaceLoadError\)/
  );
  assert.match(source, /retryButton\.textContent = t\("retry"\)/);
  assert.match(source, /await loadInitialWorkspace\(\)/);
  assert.match(
    source,
    /const workspaceTabs = Array\.from\(document\.querySelectorAll\("\.sidebar-tab"\)\)/
  );
  assert.match(html, /id="session-list"/);
});

test("工作区状态播报保留在无障碍树中", async () => {
  const html = await readProjectFile("public/index.html");
  const css = await readProjectFile("public/styles.css");

  assert.match(html, /id="aria-live"[\s\S]*class="visually-hidden"/);
  assert.doesNotMatch(html, /id="aria-live"[\s\S]*class="hidden"/);
  assert.match(
    css,
    /\.visually-hidden\s*\{[\s\S]*position: absolute;[\s\S]*clip: rect\(0 0 0 0\)/
  );
  assert.doesNotMatch(css, /\.visually-hidden\s*\{[^}]*display:\s*none/);
});

test("桌面运行时缺失通过稳定错误码显示引导", async () => {
  const source = await readProjectFile("public/app.js");
  const client = await readProjectFile("public/api-client.js");

  assert.match(
    client,
    /export const DESKTOP_RUNTIME_REQUIRED = "desktop_runtime_required"/
  );
  assert.match(client, /error\.code = DESKTOP_RUNTIME_REQUIRED/);
  assert.match(source, /error\.code === DESKTOP_RUNTIME_REQUIRED/);
  assert.doesNotMatch(source, /message\.includes\("AllSessions 桌面应用"\)/);
});

test("工作区新增说明文字使用可缩放字号且不依赖 !important", async () => {
  const css = await readProjectFile("public/styles.css");

  assert.match(
    css,
    /\.workspace-load-state \.workspace-load-detail\s*\{[^}]*font-size: 0\.75rem/
  );
  assert.doesNotMatch(
    css,
    /\.workspace-load-detail\s*\{[^}]*!important/
  );
});

test("属性型 i18n 不会覆盖带子节点的控件内容", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/i18n.js");

  assert.match(
    html,
    /class="sidebar-tabs workspace-tabs"[\s\S]*data-i18n-attr="aria-label"[\s\S]*data-sidebar-tab="list"/
  );
  assert.match(source, /if \(el\.dataset\.i18nAttr\) return;/);
  assert.match(source, /el\.setAttribute\(attr, t\(key\)\)/);
});

test("统计与工具视图使用全宽工作区且手机端提供返回入口", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(html, /id="mobile-back-btn"/);
  assert.match(
    css,
    /\.app-layout\[data-view="stats"\]\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/
  );
  assert.match(
    css,
    /\.app-layout\[data-view="tools"\]\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)[\s\S]*\.mobile-back-button\s*\{[\s\S]*display: inline-flex/
  );
  assert.match(
    css,
    /\.sidebar-left,\s*\.detail-shell\s*\{\s*scroll-margin-top: 158px/
  );
  assert.match(source, /const MOBILE_LAYOUT_QUERY = "\(max-width: 760px\)"/);
  assert.match(
    source,
    /scrollToWorkspaceSection\(document\.querySelector\("#detail-panel"\)\)/
  );
});

test("统计页展示真实事件总数并使用最近日期", async () => {
  const source = await readProjectFile("public/stats-view.js");

  assert.match(source, /value: formatCount\(stats\.total_events\)/);
  assert.match(source, /\(stats\.by_date \|\| \[\]\)\.slice\(-14\)/);
  assert.doesNotMatch(source, /document\.querySelector/);
  const css = await readProjectFile("public/styles/analytics.css");
  assert.match(css, /\.stats-empty\s*\{/);
});

test("页面复用项目图标作为 favicon 与工具栏标识", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");

  assert.match(
    html,
    /<link rel="icon" type="image\/png" href="\/assets\/allsessions-icon-v2\.png"/
  );
  assert.match(
    html,
    /<a[\s\S]*id="home-link"[\s\S]*class="toolbar-brand"[\s\S]*href="\/"[\s\S]*<img[\s\S]*class="toolbar-logo"[\s\S]*src="\/assets\/allsessions-icon-v2\.png"/
  );
  assert.match(source, /async function returnHome\(\)/);
  assert.match(source, /elements\.homeLink\?\.addEventListener\("click"/);
});

test("会话列表项具备三段式信息层级", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(html, /class="session-primary"/);
  assert.match(html, /class="session-secondary"/);
  assert.match(html, /class="session-tertiary"/);
  assert.match(html, /class="session-title"/);
  assert.match(html, /class="session-preview"/);
  assert.match(html, /class="session-cwd session-cwd-main"/);
  assert.match(html, /class="session-cwd-path"/);
  assert.match(html, /class="session-row"[\s\S]*class="session-item"/);
  assert.match(source, /row\.append\(archiveBtn\)/);
  assert.doesNotMatch(source, /button\.append\(archiveBtn\)/);
  assert.match(css, /\.session-list\s*\{[\s\S]*overflow-x: hidden/);
  assert.match(
    css,
    /\.session-primary\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/
  );
  assert.match(css, /\.session-title\s*\{[\s\S]*-webkit-line-clamp: 2/);
});

test("页面提供项目导航入口并复用 cwd 筛选", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(html, /id="project-list"/);
  assert.match(source, /function renderProjectNav\(\)/);
  assert.match(source, /async function setCwdFilter\(cwd\)/);
  assert.match(source, /state\.filters\.cwd = cwd/);
  assert.match(source, /showAllProjects/);
  assert.match(source, /showMoreProjects/);
  assert.match(css, /\.project-nav\b/);
  assert.match(css, /\.project-item\b/);
});

test("详情页提供会话内搜索、工具消息开关和消息导航", async () => {
  const html = await readProjectFile("public/index.html");
  const app = await readProjectFile("public/app.js");
  const filter = await readProjectFile("public/conversation-filter.js");
  const view = await readProjectFile("public/conversation-view.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(html, /id="detail-search-input"/);
  assert.match(html, /id="show-tools-toggle"/);
  assert.match(html, /id="show-context-toggle"/);
  assert.match(html, /id="message-nav-inline-list"/);
  assert.match(app, /createConversationView/);
  assert.match(view, /createMessageNavSection/);
  assert.match(filter, /showTools \|\| message\.role !== "tool"/);
  assert.match(
    filter,
    /showContext \|\| message\.synthetic_context !== true/
  );
  assert.match(css, /\.conversation-toolbar\b/);
  assert.match(css, /\.message-nav-list\b/);
});

test("详情将显示选项和导出收进按需展开的控件", async () => {
  const html = await readProjectFile("public/index.html");
  const css = await readProjectFile("public/styles.css");

  assert.match(html, /<details class="conversation-display-options">/);
  assert.match(html, /<summary data-i18n="displayOptions">/);
  assert.match(html, /<details class="export-menu">/);
  assert.match(html, /<summary data-i18n="export">/);
  assert.match(
    css,
    /\.conversation-display-options-body,[\s\S]*\.export-menu \.export-actions\s*\{[\s\S]*position: absolute/
  );
});

test("会话搜索工具区随内容流排列，不会覆盖消息", async () => {
  const css = await readProjectFile("public/styles.css");

  assert.match(
    css,
    /\.conversation-toolbar\s*\{[^}]*margin: 0 0 12px;[^}]*border-bottom: 1px solid var\(--line\)/
  );
  assert.doesNotMatch(css, /\.conversation-toolbar\s*\{[^}]*position: sticky/);
});

test("中等宽度顶部栏为粘滞侧栏预留高度", async () => {
  const css = await readProjectFile("public/styles.css");

  assert.match(
    css,
    /@media \(max-width: 1040px\)\s*\{\s*:root\s*\{\s*--header-h: 114px/
  );
  assert.match(
    css,
    /\.sidebar-left,[\s\S]*\.props-panel\s*\{[\s\S]*top: calc\(var\(--header-h\) \+ 12px\)/
  );
});

test("折叠内容和属性复制按钮提供可访问状态与可点击区域", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/conversation-view.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(
    html,
    /class="message-toggle" type="button" aria-expanded="false"/
  );
  assert.match(
    source,
    /function setMessageCardCollapsed\(card, toggleButton, collapsed\)/
  );
  assert.match(
    source,
    /toggleButton\.setAttribute\("aria-expanded", collapsed \? "false" : "true"\)/
  );
  assert.match(
    css,
    /\.message-toggle,[\s\S]*\.raw-event-toggle\s*\{[\s\S]*width: 24px;[\s\S]*height: 24px/
  );
  assert.match(css, /\.prop-copy\s*\{[\s\S]*min-height: 24px/);
});

test("会话正文安全渲染 Markdown，导航使用纯文本摘要", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/conversation-view.js");
  const markdown = await readProjectFile("public/markdown.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(html, /class="message-text markdown-body"/);
  assert.match(source, /renderMarkdown\(messageContent, messageText\)/);
  assert.match(source, /markdownToPlainText\(displayMessageText\(message\)\)/);
  assert.doesNotMatch(markdown, /innerHTML/);
  assert.match(css, /\.markdown-body pre\b/);
  assert.match(css, /\.markdown-body table\b/);
});

test("长工具命令不会撑宽会话详情", async () => {
  const css = await readProjectFile("public/styles.css");

  assert.match(
    css,
    /\.detail-view\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/
  );
  assert.match(
    css,
    /\.conversation-list,[\s\S]*\.raw-events\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/
  );
  assert.match(
    css,
    /\.message-card,[\s\S]*\.raw-event-card\s*\{[\s\S]*min-width: 0;[\s\S]*max-width: 100%/
  );
  assert.match(css, /\.markdown-body pre\s*\{[\s\S]*max-width: 100%/);
});

test("列表和详情为不同 Agent 来源设置明确标识", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(
    html,
    /class="session-primary">[\s\S]*class="session-source-kind"[\s\S]*class="session-title"/
  );
  assert.match(source, /sourceKindEl\.dataset\.sourceKind = sourceKind/);
  assert.match(source, /span\.dataset\.sourceKind = sourceKind/);
  assert.match(
    source,
    /fillSelect\(elements\.sourceKindFilter,[\s\S]*sourceKindLabel\)/
  );
  assert.match(css, /data-source-kind="claude_code"/);
  assert.match(css, /data-source-kind="gemini"/);
  assert.match(css, /data-source-kind="codex_archived"/);
});

test("详情页默认使用双栏阅读布局并按需打开会话信息", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(
    html,
    /id="session-inspector-toggle"[\s\S]*aria-expanded="false"/
  );
  assert.match(html, /id="props-panel" aria-hidden="true"/);
  assert.match(source, /function setInspectorOpen\(open\)/);
  assert.match(
    css,
    /\.app-layout\s*\{[\s\S]*grid-template-columns: var\(--sidebar-w\) minmax\(0, 1fr\)/
  );
  assert.match(css, /\.props-panel\.is-open\s*\{\s*display: block/);
});

test("普通对话默认展开，仅收起工具、上下文和超长消息", async () => {
  const source = await readProjectFile("public/conversation-view.js");

  assert.match(source, /const shouldCollapse\s*=\s*message\.role === "tool"/);
  assert.match(source, /markdownToPlainText\(messageText\)\.length > 1800/);
  assert.match(
    source,
    /setMessageCardCollapsed\(card, toggleButton, shouldCollapse\)/
  );
});

test("维护预览期间仍允许关闭维护模式", async () => {
  const source = await readProjectFile("public/app.js");

  assert.match(
    source,
    /setCodexMigrationBusy\(true, \{ allowMaintenanceToggle: true \}\)/
  );
});

test("Codex 维护流程提供分阶段操作指引", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const css = await readProjectFile("public/styles/maintenance.css");

  assert.match(html, /id="codex-migration-next-step"/);
  assert.match(html, /id="codex-migration-plan-stale"[\s\S]*data-i18n="migrationPlanStale"/);
  assert.match(html, /id="codex-migration-metrics"[\s\S]*data-stale="false"/);
  assert.match(html, /id="codex-migration-diagnostics"[\s\S]*data-stale="false"/);
  assert.match(html, /data-i18n="maintenanceSafetyTitle"/);
  assert.match(html, /data-i18n="migrationRollbackHint"/);
  assert.doesNotMatch(
    html.match(/<button[^>]*id="codex-migration-preview-btn"[\s\S]*?<\/button>/)?.[0] || "",
    /data-i18n/
  );
  assert.match(source, /function syncCodexMigrationFlowState\(\)/);
  assert.match(source, /scanHistoricalProviders/);
  assert.match(source, /buildExactRepairPlan/);
  assert.match(source, /rebuildRepairPlan/);
  assert.match(source, /dataset\.stale = String\(stale\)/);
  assert.match(css, /\.migration-metrics\[data-stale="true"\][\s\S]*opacity: 0\.58/);
});

test("会话列表支持筛选状态 chips 和日期分组", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(html, /id="active-filter-bar"/);
  assert.match(source, /function renderActiveFilters\(\)/);
  assert.match(source, /function appendSessionGroupHeader\(label, count\)/);
  assert.match(css, /\.active-filter-bar\b/);
  assert.match(css, /\.filter-chip\b/);
  assert.match(css, /\.session-group-header\b/);
});

test("会话来源只在左侧筛选中出现，顶部保留搜索主路径", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(
    html,
    /<aside class="sidebar-left"[\s\S]*id="sidebar-filters"[\s\S]*id="source-kind-filter"/
  );
  assert.match(
    html,
    /<header class="toolbar">[\s\S]*class="sidebar-tabs workspace-tabs"[\s\S]*class="toolbar-center"/
  );
  assert.doesNotMatch(html, /id="source-kind-quick-filter"/);
  assert.doesNotMatch(source, /renderSourceKindQuickFilter/);
  assert.match(source, /async function setSourceKindFilter\(sourceKind\)/);
  assert.match(
    source,
    /elements\.sourceKindFilter\?\.addEventListener\("change",[\s\S]*setSourceKindFilter\(event\.target\.value\)/
  );
  assert.match(
    css,
    /\.toolbar\s*\{[\s\S]*grid-template-columns: auto auto minmax\(300px, 1fr\) auto/
  );
});

test("本地归档不会被初始自动选中，空页仍可继续加载", async () => {
  const source = await readProjectFile("public/app.js");

  assert.doesNotMatch(
    source,
    /visibleSessions\(\)\[0\]\s*\|\|\s*state\.sessions\[0\]/
  );
  assert.match(
    source,
    /if \(!visible\.length\) \{[\s\S]*renderLoadMoreButton\(\);[\s\S]*updateSessionCount\(\);[\s\S]*return;/
  );
});

test("顶部筛选按钮聚焦筛选区而不是切换到统计页", async () => {
  const source = await readProjectFile("public/app.js");

  assert.match(
    source,
    /document\.querySelector\(\s*'\.sidebar-tab\[data-sidebar-tab="list"\]'\s*\)/
  );
  assert.match(source, /elements\.sourceKindFilter\?\.focus\(\)/);
  assert.doesNotMatch(
    source,
    /document\.querySelector\('\.sidebar-tab\[data-sidebar-tab="stats"\]'\)/
  );
});

test("全局搜索支持快捷键并从其他视图返回会话列表", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");

  assert.match(html, /<kbd class="search-kbd">⌘ K<\/kbd>/);
  assert.match(
    source,
    /\(event\.metaKey \|\| event\.ctrlKey\) && event\.key\.toLowerCase\(\) === "k"/
  );
  assert.match(source, /const switchedView = state\.activeView !== "list"/);
  assert.match(source, /await activateWorkspaceView\("list"\)/);
  assert.match(source, /elements\.searchInput\?\.focus\(\)/);
});

test("搜索结果支持使用服务端 cursor 继续加载", async () => {
  const source = await readProjectFile("public/app.js");

  assert.match(source, /function buildSearchUrl\(\{ cursor \} = \{\}\)/);
  assert.match(source, /if \(cursor\) params\.set\("cursor", cursor\)/);
  assert.match(source, /state\.hasMore = data\.has_more/);
  assert.match(
    source,
    /state\.searchQuery\s*\? buildSearchUrl\(\{ cursor: state\.nextCursor \}\)/
  );
});

test("样式包含紧凑工具栏和详情元信息条", async () => {
  const css = await readProjectFile("public/styles.css");

  assert.match(css, /\.toolbar\b/);
  assert.match(css, /\.sidebar-left\b/);
  assert.match(css, /\.detail-tags\b/);
  assert.match(css, /\.props-panel\b/);
  assert.match(css, /\.session-list-shell\b/);
});

test("语言切换会重渲染动态内容而不是只更新静态文案", async () => {
  const source = await readProjectFile("public/app.js");

  assert.match(
    source,
    /function rerenderLocalizedContent\(\)[\s\S]*renderSessionList\(\)/
  );
  assert.match(
    source,
    /function rerenderLocalizedContent\(\)[\s\S]*renderDetailTags\(state\.currentDetail\.summary\)/
  );
  assert.match(
    source,
    /elements\.langToggle\.addEventListener\("click", \(\) => \{[\s\S]*rerenderLocalizedContent\(\);/
  );
});

test("时间格式会跟随当前语言", async () => {
  const source = await readProjectFile("public/session-format.js");

  assert.match(source, /return getLang\(\) === "zh" \? "zh-CN" : "en";/);
  assert.match(source, /new Intl\.DateTimeFormat\(locale\(\),/);
});

test("session root 使用动态 i18n", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");

  assert.match(
    html,
    /id="session-root"[\s\S]*class="meta-value"[\s\S]*data-i18n="loading"/
  );
  assert.match(
    source,
    /function syncSessionRoot\(\)[\s\S]*session_roots[\s\S]*t\("loading"\)/
  );
});

test("详情 tabs 的 aria-label 使用已定义的 i18n key", async () => {
  const html = await readProjectFile("public/index.html");
  const dict = await readProjectFile("public/i18n.js");

  assert.match(
    html,
    /data-i18n="tabsAriaLabel"[\s\S]*data-i18n-attr="aria-label"/
  );
  assert.match(dict, /zh:[\s\S]*tabsAriaLabel: "详情视图切换"/);
  assert.match(dict, /en:[\s\S]*tabsAriaLabel: "Detail view tabs"/);
});

test("详情标签不会用 innerHTML 拼接会话字段", async () => {
  const source = await readProjectFile("public/app.js");

  assert.match(source, /function createTagIcon\(icon\)/);
  assert.doesNotMatch(source, /span\.innerHTML\s*=/);
});

test("Codex 归档会话开关会进入 URL 并触发重新加载", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const dict = await readProjectFile("public/i18n.js");

  assert.match(html, /id="show-codex-archived-toggle"/);
  assert.match(html, /data-i18n="showCodexArchived"/);
  assert.match(dict, /showCodexArchived: "显示 Codex 归档会话"/);
  assert.match(source, /showCodexArchived: false/);
  assert.match(source, /params\.set\("show_codex_archived", "1"\)/);
  assert.match(
    source,
    /elements\.showCodexArchivedToggle\.addEventListener\("change", async \(\) => \{[\s\S]*loadSessions\(\), loadStats\(\)/
  );
});

test("隐藏会话开关会进入 URL 并触发重新加载", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const dict = await readProjectFile("public/i18n.js");

  assert.match(html, /id="show-hidden-toggle"/);
  assert.match(html, /data-i18n="showHidden"/);
  assert.match(dict, /showHidden: "显示隐藏会话"/);
  assert.match(dict, /hiddenSubagent: "Subagent"/);
  assert.match(source, /showHidden: false/);
  assert.match(source, /params\.set\("show_hidden", "1"\)/);
  assert.match(source, /function hiddenReasonLabel\(session\)/);
  assert.match(source, /function visibilityLabel\(session\)/);
  assert.match(source, /value: visibilityLabel\(summary\)/);
  assert.match(source, /session-hidden-reason/);
  assert.match(
    source,
    /elements\.showHiddenToggle\.addEventListener\("change", async \(\) => \{[\s\S]*loadSessions\(\), loadStats\(\)/
  );
});

test("页面提供默认关闭且需显式选择来源的 Codex 可见性修复入口", async () => {
  const html = await readProjectFile("public/index.html");
  const app = await readProjectFile("public/app.js");

  assert.match(html, /data-sidebar-tab="tools"/);
  assert.match(html, /id="codex-migration-preview-btn"/);
  assert.match(html, /id="codex-migration-apply-btn"/);
  assert.match(html, /id="codex-migration-rollback-btn"/);
  assert.match(html, /id="codex-migration-diagnostics"/);
  assert.match(html, /id="codex-migration-card"[\s\S]*data-enabled="false"/);
  assert.match(html, /id="codex-maintenance-toggle"[\s\S]*role="switch"/);
  assert.match(html, /data-i18n="maintenanceBoundary"/);
  assert.match(html, /id="codex-archive-viewer-title"/);
  assert.match(html, /data-i18n="codexArchiveViewerDesc"/);
  assert.match(app, /\/api\/codex-maintenance/);
  assert.match(app, /bindTauriSessionEvents/);
  assert.match(app, /codexMigrationPreviewRequestGate\.cancel\(\)/);
  assert.match(app, /signal: request\.signal/);
  assert.doesNotMatch(app, /if \(isTools && isCodexMaintenanceEnabled\(\)/);
});
