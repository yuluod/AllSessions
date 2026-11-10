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

test("Alt 和 AltGraph 组合不触发裸键操作或应用命令", () => {
  for (const key of ["f", "a", "r", "l", "j", "k", "n", "1", "/"]) {
    assert.equal(resolveGlobalShortcut({ key, altKey: true }, idle), null);
    assert.equal(
      resolveGlobalShortcut({ key, altKey: true, ctrlKey: true }, idle),
      null
    );
    assert.equal(
      resolveGlobalShortcut(
        { key, getModifierState: (name) => name === "AltGraph" },
        idle
      ),
      null
    );
  }
});

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
  assert.equal(resolveGlobalShortcut({ key: "1", altKey: true }, idle), null);
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

test("输入框保留搜索快捷键，弹窗隔离后台导航并保留 Escape", () => {
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
  assert.equal(
    resolveGlobalShortcut({ key: "K", ctrlKey: true }, dialog),
    null
  );
  assert.deepEqual(resolveGlobalShortcut({ key: "Escape" }, dialog), {
    type: "close-dialog",
  });
});

test("Cmd/Ctrl 组合键触发应用级命令", () => {
  assert.deepEqual(resolveGlobalShortcut({ key: ",", metaKey: true }, idle), {
    type: "toggle-settings",
  });
  assert.deepEqual(resolveGlobalShortcut({ key: ",", ctrlKey: true }, idle), {
    type: "toggle-settings",
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "r", metaKey: true }, idle), {
    type: "refresh",
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "f", metaKey: true }, idle), {
    type: "focus-search",
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "1", metaKey: true }, idle), {
    type: "switch-view",
    view: "list",
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "3", ctrlKey: true }, idle), {
    type: "switch-view",
    view: "tools",
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "i", metaKey: true }, idle), {
    type: "toggle-inspector",
  });
  assert.equal(resolveGlobalShortcut({ key: "x", metaKey: true }, idle), null);
});

test("弹窗中仅设置自身允许快捷键关闭，不穿透到下层设置或工作区", () => {
  const editing = { ...idle, editableTarget: true };
  const dialog = { ...idle, dialogOpen: true };
  assert.deepEqual(
    resolveGlobalShortcut(
      { key: ",", metaKey: true },
      { ...dialog, settingsDialogActive: true }
    ),
    {
      type: "toggle-settings",
    }
  );
  for (const key of [",", "r", "k", "f"]) {
    assert.equal(resolveGlobalShortcut({ key, metaKey: true }, dialog), null);
  }
  assert.equal(
    resolveGlobalShortcut({ key: "1", metaKey: true }, dialog),
    null
  );
  assert.equal(
    resolveGlobalShortcut({ key: "i", metaKey: true }, dialog),
    null
  );
  assert.equal(
    resolveGlobalShortcut({ key: "i", metaKey: true }, editing),
    null
  );
  assert.deepEqual(
    resolveGlobalShortcut({ key: "1", metaKey: true }, editing),
    { type: "switch-view", view: "list" }
  );
});

test("会话详情与列表操作提供裸键快捷键，? 打开快捷键图例", () => {
  assert.deepEqual(resolveGlobalShortcut({ key: "/" }, idle), {
    type: "focus-detail-search",
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "?" }, idle), {
    type: "shortcuts-help",
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "f" }, idle), {
    type: "toggle-favorite",
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "a" }, idle), {
    type: "toggle-archive",
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "r" }, idle), {
    type: "resume-session",
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "l" }, idle), {
    type: "load-more",
  });
  assert.deepEqual(resolveGlobalShortcut({ key: "F" }, idle), {
    type: "toggle-favorite",
  });
});

test("裸键快捷键在输入框与对话框中不触发", () => {
  const editing = { ...idle, editableTarget: true };
  const dialog = { ...idle, dialogOpen: true };
  for (const key of ["/", "?", "f", "a", "r", "l"]) {
    assert.equal(resolveGlobalShortcut({ key }, editing), null, key);
    assert.equal(resolveGlobalShortcut({ key }, dialog), null, key);
  }
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

test("批量模式仅对聚焦会话处理空格，组合输入不触发任何快捷键", () => {
  const context = {
    editableTarget: false,
    dialogOpen: false,
    inspectorOpen: false,
    arrowFromList: true,
    bulkSelection: true,
    focusedSession: true,
  };
  assert.deepEqual(resolveGlobalShortcut({ key: " " }, context), {
    type: "toggle-selection",
  });
  assert.equal(
    resolveGlobalShortcut({ key: " " }, { ...context, bulkSelection: false }),
    null
  );
  assert.equal(
    resolveGlobalShortcut({ key: " " }, { ...context, focusedSession: false }),
    null
  );
  assert.equal(
    resolveGlobalShortcut({ key: " ", isComposing: true }, context),
    null
  );
  assert.equal(
    resolveGlobalShortcut({ key: "r", keyCode: 229 }, context),
    null
  );
  assert.equal(
    resolveGlobalShortcut({ key: " " }, { ...context, editableTarget: true }),
    null
  );
  assert.equal(
    resolveGlobalShortcut({ key: " " }, { ...context, dialogOpen: true }),
    null
  );
});

test("用户消息快捷键支持前后跳转且不干扰编辑", () => {
  const context = { editableTarget: false, dialogOpen: false };
  assert.deepEqual(resolveGlobalShortcut({ key: "n" }, context), {
    type: "move-message",
    direction: 1,
  });
  assert.deepEqual(
    resolveGlobalShortcut({ key: "N", shiftKey: true }, context),
    { type: "move-message", direction: -1 }
  );
  assert.equal(
    resolveGlobalShortcut({ key: "n" }, { ...context, editableTarget: true }),
    null
  );
});
