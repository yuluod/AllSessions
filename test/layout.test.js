import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readProjectFile(relativePath) {
  return fs.readFile(path.join(rootDir, relativePath), "utf8");
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

  assert.match(html, /<header class="toolbar">[\s\S]*class="sidebar-tabs workspace-tabs"/);
  assert.match(html, /<details id="sidebar-filters" class="sidebar-filters">/);
  assert.match(html, /<details class="project-nav">/);
  assert.doesNotMatch(html, /<details class="project-nav" open>/);
  assert.match(html, /<details class="visibility-panel">/);
});

test("属性型 i18n 不会覆盖带子节点的控件内容", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/i18n.js");

  assert.match(html, /class="sidebar-tabs workspace-tabs"[\s\S]*data-i18n-attr="aria-label"[\s\S]*data-sidebar-tab="list"/);
  assert.match(source, /if \(el\.dataset\.i18nAttr\) return;/);
  assert.match(source, /el\.setAttribute\(attr, t\(key\)\)/);
});

test("统计与工具视图使用全宽工作区且手机端提供返回入口", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(html, /id="mobile-back-btn"/);
  assert.match(css, /\.app-layout\[data-view="stats"\]\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.app-layout\[data-view="tools"\]\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.mobile-back-button\s*\{[\s\S]*display: inline-flex/);
  assert.match(css, /\.sidebar-left,\s*\.detail-shell\s*\{\s*scroll-margin-top: 158px/);
  assert.match(source, /const MOBILE_LAYOUT_QUERY = "\(max-width: 760px\)"/);
  assert.match(source, /scrollToWorkspaceSection\(document\.querySelector\("#detail-panel"\)\)/);
});

test("统计页展示真实事件总数并使用最近日期", async () => {
  const source = await readProjectFile("public/app.js");
  const store = await readProjectFile("server/session-store.js");

  assert.match(source, /value: formatCount\(stats\.total_events\)/);
  assert.match(source, /\(stats\.by_date \|\| \[\]\)\.slice\(-14\)/);
  assert.match(store, /total_events: totalEvents/);
});

test("页面复用项目图标作为 favicon 与工具栏标识", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");

  assert.match(html, /<link rel="icon" type="image\/png" href="\/assets\/allsessions-icon-v2\.png"/);
  assert.match(html, /<a id="home-link" class="toolbar-brand" href="\/"[\s\S]*<img class="toolbar-logo" src="\/assets\/allsessions-icon-v2\.png"/);
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
  assert.match(css, /\.session-primary\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
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
  const source = await readProjectFile("public/app.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(html, /id="detail-search-input"/);
  assert.match(html, /id="show-tools-toggle"/);
  assert.match(html, /id="show-context-toggle"/);
  assert.match(html, /id="message-nav-inline-list"/);
  assert.match(source, /function filteredConversationMessages\(messages\)/);
  assert.match(source, /function createMessageNavSection\(messages\)/);
  assert.match(source, /state\.showTools \|\| message\.role !== "tool"/);
  assert.match(source, /state\.showContext \|\| message\.synthetic_context !== true/);
  assert.match(css, /\.conversation-toolbar\b/);
  assert.match(css, /\.message-nav-list\b/);
});

test("会话正文安全渲染 Markdown，导航使用纯文本摘要", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const markdown = await readProjectFile("public/markdown.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(html, /class="message-text markdown-body"/);
  assert.match(source, /renderMarkdown\(fragment\.querySelector\("\.message-text"\), messageText\)/);
  assert.match(source, /markdownToPlainText\(displayMessageText\(message\)\)/);
  assert.doesNotMatch(markdown, /innerHTML/);
  assert.match(css, /\.markdown-body pre\b/);
  assert.match(css, /\.markdown-body table\b/);
});

test("长工具命令不会撑宽会话详情", async () => {
  const css = await readProjectFile("public/styles.css");

  assert.match(css, /\.detail-view\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.conversation-list,[\s\S]*\.raw-events\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.message-card,[\s\S]*\.raw-event-card\s*\{[\s\S]*min-width: 0;[\s\S]*max-width: 100%/);
  assert.match(css, /\.markdown-body pre\s*\{[\s\S]*max-width: 100%/);
});

test("列表和详情为不同 Agent 来源设置明确标识", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(html, /class="session-primary">[\s\S]*class="session-source-kind"[\s\S]*class="session-title"/);
  assert.match(source, /sourceKindEl\.dataset\.sourceKind = sourceKind/);
  assert.match(source, /span\.dataset\.sourceKind = sourceKind/);
  assert.match(source, /fillSelect\(elements\.sourceKindFilter,[\s\S]*sourceKindLabel\)/);
  assert.match(css, /data-source-kind="claude_code"/);
  assert.match(css, /data-source-kind="gemini"/);
  assert.match(css, /data-source-kind="codex_archived"/);
});

test("详情页默认使用双栏阅读布局并按需打开会话信息", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(html, /id="session-inspector-toggle"[\s\S]*aria-expanded="false"/);
  assert.match(html, /id="props-panel" aria-hidden="true"/);
  assert.match(source, /function setInspectorOpen\(open\)/);
  assert.match(css, /\.app-layout\s*\{[\s\S]*grid-template-columns: var\(--sidebar-w\) minmax\(0, 1fr\)/);
  assert.match(css, /\.props-panel\.is-open\s*\{\s*display: block/);
});

test("普通对话默认展开，仅收起工具、上下文和超长消息", async () => {
  const source = await readProjectFile("public/app.js");

  assert.match(source, /const shouldCollapse = message\.role === "tool"/);
  assert.match(source, /markdownToPlainText\(messageText\)\.length > 1800/);
  assert.match(source, /card\.classList\.toggle\("collapsed", shouldCollapse\)/);
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

test("会话列表提供一级来源快速切换并与高级筛选同步", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const css = await readProjectFile("public/styles.css");

  assert.match(html, /id="source-kind-quick-filter"[\s\S]*role="tablist"/);
  assert.match(html, /<header class="toolbar">[\s\S]*class="sidebar-tabs workspace-tabs"[\s\S]*id="source-kind-quick-filter"[\s\S]*class="toolbar-center"/);
  assert.doesNotMatch(html, /<aside class="sidebar-left"[\s\S]{0,300}id="source-kind-quick-filter"/);
  assert.doesNotMatch(html, /class="session-list-shell">[\s\S]{0,200}id="source-kind-quick-filter"/);
  assert.match(source, /const QUICK_SOURCE_KINDS = \["", "codex", "claude_code", "gemini"\]/);
  assert.match(source, /async function setSourceKindFilter\(sourceKind\)/);
  assert.match(source, /elements\.sourceKindFilter\?\.addEventListener\("change",[\s\S]*setSourceKindFilter\(event\.target\.value\)/);
  assert.match(source, /\.\.\.QUICK_SOURCE_KINDS\.filter\(Boolean\)/);
  assert.match(css, /\.source-kind-quick-filter\s*\{[\s\S]*grid-template-columns: 0\.8fr 1fr 1\.35fr 1\.25fr/);
  assert.match(css, /\.source-kind-quick-button\.active\b/);
  assert.match(css, /\.toolbar-source-filter\s*\{[\s\S]*width: 100%/);
  assert.match(css, /\.toolbar\s*\{[\s\S]*grid-template-columns: auto auto minmax\(300px, 340px\) minmax\(220px, 360px\) auto/);
});

test("本地归档不会被初始自动选中，空页仍可继续加载", async () => {
  const source = await readProjectFile("public/app.js");

  assert.doesNotMatch(source, /visibleSessions\(\)\[0\]\s*\|\|\s*state\.sessions\[0\]/);
  assert.match(
    source,
    /if \(!visible\.length\) \{[\s\S]*renderLoadMoreButton\(\);[\s\S]*updateSessionCount\(\);[\s\S]*return;/
  );
});

test("顶部筛选按钮聚焦筛选区而不是切换到统计页", async () => {
  const source = await readProjectFile("public/app.js");

  assert.match(source, /document\.querySelector\('\.sidebar-tab\[data-sidebar-tab="list"\]'\)/);
  assert.match(source, /elements\.sourceKindFilter\?\.focus\(\)/);
  assert.doesNotMatch(source, /document\.querySelector\('\.sidebar-tab\[data-sidebar-tab="stats"\]'\)/);
});

test("全局搜索支持快捷键并从其他视图返回会话列表", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");

  assert.match(html, /<kbd class="search-kbd">⌘ K<\/kbd>/);
  assert.match(source, /\(event\.metaKey \|\| event\.ctrlKey\) && event\.key\.toLowerCase\(\) === "k"/);
  assert.match(source, /const switchedView = state\.activeView !== "list"/);
  assert.match(source, /await activateWorkspaceView\("list"\)/);
  assert.match(source, /elements\.searchInput\?\.focus\(\)/);
});

test("搜索结果支持使用服务端 cursor 继续加载", async () => {
  const source = await readProjectFile("public/app.js");

  assert.match(source, /function buildSearchUrl\(\{ cursor \} = \{\}\)/);
  assert.match(source, /if \(cursor\) params\.set\("cursor", cursor\)/);
  assert.match(source, /state\.hasMore = data\.has_more/);
  assert.match(source, /state\.searchQuery\s*\? buildSearchUrl\(\{ cursor: state\.nextCursor \}\)/);
});

test("样式包含紧凑工具栏和详情元信息条", async () => {
  const css = await readProjectFile("public/styles.css");

  assert.match(css, /\.toolbar\b/);
  assert.match(css, /\.sidebar-left\b/);
  assert.match(css, /\.detail-tags\b/);
  assert.match(css, /\.props-panel\b/);
  assert.match(css, /\.session-list-shell\b/);
});

test("启动流程会等待 watcher 初始化完成", async () => {
  const source = await readProjectFile("server/index.js");

  assert.match(source, /await store\.watch\(\);/);
});

test("语言切换会重渲染动态内容而不是只更新静态文案", async () => {
  const source = await readProjectFile("public/app.js");

  assert.match(source, /function rerenderLocalizedContent\(\)[\s\S]*renderSessionList\(\)/);
  assert.match(source, /function rerenderLocalizedContent\(\)[\s\S]*renderDetailTags\(state\.currentDetail\.summary\)/);
  assert.match(source, /elements\.langToggle\.addEventListener\("click", \(\) => \{[\s\S]*rerenderLocalizedContent\(\);/);
});

test("时间格式会跟随当前语言", async () => {
  const source = await readProjectFile("public/app.js");

  assert.match(source, /const locale = getLang\(\) === "zh" \? "zh-CN" : "en";/);
  assert.match(source, /new Intl\.DateTimeFormat\(locale,/);
});

test("session root 使用动态 i18n", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");

  assert.match(html, /id="session-root" class="meta-value" data-i18n="loading">加载中\.\.\.<\/span>/);
  assert.match(source, /function syncSessionRoot\(\)[\s\S]*session_roots[\s\S]*t\("loading"\)/);
});

test("详情 tabs 的 aria-label 使用已定义的 i18n key", async () => {
  const html = await readProjectFile("public/index.html");
  const dict = await readProjectFile("public/i18n.js");

  assert.match(html, /data-i18n="tabsAriaLabel" data-i18n-attr="aria-label"/);
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
  assert.match(source, /elements\.showCodexArchivedToggle\.addEventListener\("change", async \(\) => \{[\s\S]*loadSessions\(\), loadStats\(\)/);
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
  assert.match(source, /elements\.showHiddenToggle\.addEventListener\("change", async \(\) => \{[\s\S]*loadSessions\(\), loadStats\(\)/);
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
  assert.match(app, /setMutationToken\(state\.capabilities/);
  assert.match(app, /codexMigrationPreviewRequestGate\.cancel\(\)/);
  assert.match(app, /signal: request\.signal/);
  assert.doesNotMatch(app, /if \(isTools && isCodexMaintenanceEnabled\(\)/);
});
