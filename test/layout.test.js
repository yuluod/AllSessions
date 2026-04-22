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
