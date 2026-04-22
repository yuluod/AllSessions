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
  assert.match(html, /class="sidebar-panel"/);
  assert.match(html, /class="filter-bar"/);
  assert.match(html, /class="detail-shell"/);
});

test("会话列表项具备三段式信息层级", async () => {
  const html = await readProjectFile("public/index.html");

  assert.match(html, /class="session-primary"/);
  assert.match(html, /class="session-secondary"/);
  assert.match(html, /class="session-tertiary"/);
});

test("样式包含紧凑工具栏和详情元信息条", async () => {
  const css = await readProjectFile("public/styles.css");

  assert.match(css, /\.toolbar\b/);
  assert.match(css, /\.sidebar-panel\b/);
  assert.match(css, /\.detail-meta-strip\b/);
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
  assert.match(source, /function rerenderLocalizedContent\(\)[\s\S]*renderSummaryGrid\(state\.currentDetail\.summary\)/);
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
  assert.match(source, /function syncSessionRoot\(\)[\s\S]*state\.facets\?\.session_root \|\| t\("loading"\)/);
});
