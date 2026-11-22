import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

async function readProjectFile(relativePath) {
  return fs.readFile(path.join(rootDir, relativePath), "utf8");
}

test("外观切换收拢态保留 Tab 顺序与辅助技术可见性", async () => {
  const css = await readProjectFile("public/styles/components.css");
  const collapsed = css.match(
    /^\.scheme-control button:not\(\[aria-pressed="true"\]\) \{([^}]*)\}/m
  )[1];
  assert.doesNotMatch(collapsed, /visibility:\s*hidden/);
  assert.match(collapsed, /pointer-events:\s*none/);
  assert.match(css, /\.scheme-control:has\(button:focus-visible\)/);
  assert.doesNotMatch(css, /\.scheme-control:focus-within/);
});

test("外观切换展开时按 DOM 顺序排布，避免点击后指针下的选项换人", async () => {
  const css = await readProjectFile("public/styles/components.css");
  const expanded = css.match(
    /\.scheme-control:has\(button:focus-visible\) button\[aria-pressed="true"\] \{([^}]*)\}/
  )[1];
  assert.match(expanded, /order:\s*0/);
  assert.match(expanded, /border-color:\s*var\(--line\)/);
  assert.match(expanded, /background:\s*var\(--surface\)/);
});

test("图标条收起时选中项保留选中样式", async () => {
  const css = await readProjectFile("public/styles/workspace.css");
  const rail = css.match(
    /^\.rail-collapsed \.scheme-control button\[aria-pressed="true"\] \{([^}]*)\}/m
  )[1];
  assert.match(rail, /order:\s*0/);
  assert.match(rail, /border-color:\s*var\(--line\)/);
  assert.match(rail, /background:\s*var\(--surface\)/);
});

test("设置按钮与外观切换同高，滚筒按 15px 视窗滚动", async () => {
  const css = await readProjectFile("public/styles/workspace.css");
  assert.match(
    css,
    /\.sidebar-settings-button \.roll-window \{[^}]*height:\s*15px/
  );
  assert.match(
    css,
    /\.sidebar-settings-button:hover \.roll-track[\s\S]*?translateY\(-15px\)/
  );
  assert.match(
    css,
    /height:\s*calc\(max\(var\(--segment-height-compact\), 25px\) \+ 8px\)/
  );
});

test("齿轮图标复用同一份 symbol，滚筒视窗内不重复完整路径", async () => {
  const html = await readProjectFile("public/index.html");
  assert.equal((html.match(/<symbol id="icon-settings"/g) || []).length, 1);
  assert.equal((html.match(/<use href="#icon-settings"/g) || []).length, 2);
});
