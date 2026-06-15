import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const rootDir = "/Users/yuluo/xcode/AllSessions";

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

test("会话列表项具备三段式信息层级", async () => {
  const html = await readProjectFile("public/index.html");

  assert.match(html, /class="session-primary"/);
  assert.match(html, /class="session-secondary"/);
  assert.match(html, /class="session-tertiary"/);
  assert.match(html, /class="session-title"/);
  assert.match(html, /class="session-preview"/);
  assert.match(html, /class="session-cwd session-cwd-main"/);
  assert.match(html, /class="session-cwd-path"/);
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
  assert.match(html, /id="message-nav-inline-list"/);
  assert.match(source, /function filteredConversationMessages\(messages\)/);
  assert.match(source, /function createMessageNavSection\(messages\)/);
  assert.match(source, /state\.showTools \|\| message\.role !== "tool"/);
  assert.match(css, /\.conversation-toolbar\b/);
  assert.match(css, /\.message-nav-list\b/);
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

test("顶部筛选按钮聚焦筛选区而不是切换到统计页", async () => {
  const source = await readProjectFile("public/app.js");

  assert.match(source, /document\.querySelector\('\.sidebar-tab\[data-sidebar-tab="list"\]'\)/);
  assert.match(source, /elements\.sourceKindFilter\?\.focus\(\)/);
  assert.doesNotMatch(source, /document\.querySelector\('\.sidebar-tab\[data-sidebar-tab="stats"\]'\)/);
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

test("session-added 事件会重渲染列表而不是仅追加单项", async () => {
  const source = await readProjectFile("public/app.js");

  assert.match(source, /eventSource\.addEventListener\("session-added"[\s\S]*renderSessionList\(\)/);
  assert.doesNotMatch(source, /eventSource\.addEventListener\("session-added"[\s\S]*appendSessionItems\(\[summary\]\)/);
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

test("页面提供 Codex Provider 迁移工具入口", async () => {
  const html = await readProjectFile("public/index.html");
  const source = await readProjectFile("public/app.js");
  const server = await readProjectFile("server/http-server.js");
  const apiClient = await readProjectFile("public/api-client.js");

  assert.match(html, /data-sidebar-tab="tools"/);
  assert.match(html, /id="codex-migration-preview-btn"/);
  assert.match(html, /id="codex-migration-apply-btn"/);
  assert.match(html, /id="codex-migration-rollback-btn"/);
  assert.match(source, /\/api\/codex-provider-migration\/preview/);
  assert.match(source, /setMutationToken\(summary\.mutation_token\)/);
  assert.match(source, /mutation: true/);
  assert.match(apiClient, /X-Session-Viewer-Token/);
  assert.match(source, /confirmedCodexAppClosed: true/);
  assert.match(server, /\/api\/codex-provider-migration\/apply/);
  assert.match(server, /assertMutationToken\(request, mutationToken\)/);
  assert.match(server, /runMigration\(\{[\s\S]*apply: true/);
});
