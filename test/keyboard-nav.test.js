import test from "node:test";
import assert from "node:assert/strict";

import {
  EDITABLE_SHORTCUT_SELECTOR,
  resolveGlobalShortcut,
  resolveTabIndex,
  wrapSelectionIndex,
} from "../public/keyboard-nav.js";

const idle = {
  editableTarget: false,
  dialogOpen: false,
  inspectorOpen: false,
  arrowFromList: true,
};

test("侧边栏 Tab 支持左右循环与 Home/End 跳转", () => {
  assert.equal(resolveTabIndex("ArrowRight", 2, 3), 0);
  assert.equal(resolveTabIndex("ArrowLeft", 0, 3), 2);
  assert.equal(resolveTabIndex("Home", 2, 3), 0);
  assert.equal(resolveTabIndex("End", 0, 3), 2);
  assert.equal(resolveTabIndex("Enter", 0, 3), null);
  assert.equal(resolveTabIndex("ArrowRight", 0, 0), null);
});

test("会话列表选择在两端循环，未选中时从头或尾开始", () => {
  assert.equal(wrapSelectionIndex(-1, 4, 1), 0);
  assert.equal(wrapSelectionIndex(-1, 4, -1), 3);
  assert.equal(wrapSelectionIndex(3, 4, 1), 0);
  assert.equal(wrapSelectionIndex(0, 4, -1), 3);
  assert.equal(wrapSelectionIndex(1, 4, 1), 2);
  assert.equal(wrapSelectionIndex(0, 0, 1), -1);
});

test("数字键切换工作区视图，带修饰键时不拦截", () => {
  assert.deepEqual(resolveGlobalShortcut({ key: "1" }, idle), {
    type: "switch-view",
    view: "list",
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "2" }, idle), {
    type: "switch-view",
    view: "stats",
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "3" }, idle), {
    type: "switch-view",
    view: "tools",
  });
  assert.equal(resolveGlobalShortcut({ key: "1", metaKey: true }, idle), null);
  assert.equal(resolveGlobalShortcut({ key: "4" }, idle), null);
});

test("j/k 始终移动选择，方向键只在焦点位于列表时生效", () => {
  const offList = { ...idle, arrowFromList: false };
  assert.deepEqual(resolveGlobalShortcut({ key: "j" }, offList), {
    type: "move-selection",
    direction: 1,
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "k" }, offList), {
    type: "move-selection",
    direction: -1,
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "ArrowDown" }, idle), {
    type: "move-selection",
    direction: 1,
  });
  assert.equal(resolveGlobalShortcut({ key: "ArrowDown" }, offList), null);
  assert.deepEqual(resolveGlobalShortcut({ key: "Enter" }, idle), {
    type: "open-focused",
  });
});

test("输入框或对话框打开时不响应导航快捷键，但保留 Escape 与 Cmd/Ctrl+K", () => {
  const editing = { ...idle, editableTarget: true };
  const dialog = { ...idle, dialogOpen: true };
  for (const key of ["1", "j", "k", "ArrowDown", "Enter"]) {
    assert.equal(resolveGlobalShortcut({ key }, editing), null, key);
    assert.equal(resolveGlobalShortcut({ key }, dialog), null, key);
  }
  assert.deepEqual(
    resolveGlobalShortcut({ key: "k", metaKey: true }, editing),
    {
      type: "focus-search",
    }
  );
  assert.deepEqual(resolveGlobalShortcut({ key: "K", ctrlKey: true }, dialog), {
    type: "focus-search",
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "Escape" }, dialog), {
    type: "close-dialog",
  });
});

test("Escape 优先关闭对话框，其次关闭属性面板，否则不处理", () => {
  assert.deepEqual(
    resolveGlobalShortcut(
      { key: "Escape" },
      { ...idle, dialogOpen: true, inspectorOpen: true }
    ),
    { type: "close-dialog" }
  );
  assert.deepEqual(
    resolveGlobalShortcut({ key: "Escape" }, { ...idle, inspectorOpen: true }),
    { type: "close-inspector" }
  );
  assert.equal(resolveGlobalShortcut({ key: "Escape" }, idle), null);
});

test("可编辑元素选择器覆盖表单控件与 contenteditable", () => {
  for (const tag of [
    "input",
    "textarea",
    "select",
    "[contenteditable='true']",
  ]) {
    assert.ok(EDITABLE_SHORTCUT_SELECTOR.includes(tag));
  }
});
