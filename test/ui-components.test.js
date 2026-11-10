import assert from "node:assert/strict";
import test from "node:test";
import {
  bindPopoverMenus,
  showDialogFromPopover,
  closeFocusedDialog,
} from "../public/ui-components.js";

test("Escape 只关闭焦点所在的上层弹窗，遵守取消保护且不依赖 DOM 顺序", () => {
  let closed = false;
  let protectedClose = true;
  const update = {
    dispatchEvent(event) {
      assert.equal(event.type, "cancel");
      if (protectedClose) event.preventDefault();
      return !event.defaultPrevented;
    },
    close() {
      closed = true;
    },
  };
  const root = {
    activeElement: { closest: () => update },
    querySelectorAll() {
      throw new Error("不得用 DOM 顺序决定弹窗层级");
    },
  };
  assert.equal(closeFocusedDialog(root), true);
  assert.equal(closed, false);
  protectedClose = false;
  assert.equal(closeFocusedDialog(root), true);
  assert.equal(closed, true);
  assert.equal(closeFocusedDialog({ activeElement: null }), false);
});

function setup() {
  const rootEvents = {};
  const menus = [0, 1].map(() => {
    const events = {};
    const summary = {
      focused: false,
      focus() {
        this.focused = true;
      },
    };
    const content = {};
    const controls = [0, 1, 2].map((index) => ({
      focused: false,
      focus() {
        this.focused = true;
      },
      matches: () => index === 1,
      getClientRects: () => [{}],
    }));
    return {
      open: false,
      summary,
      content,
      controls,
      events,
      contains: (target) =>
        target === summary || target === content || controls.includes(target),
      querySelector: () => summary,
      querySelectorAll: () => controls,
      addEventListener: (name, handler) => {
        events[name] = handler;
      },
    };
  });
  bindPopoverMenus({
    querySelectorAll: () => menus,
    addEventListener: (name, handler) => {
      rootEvents[name] = handler;
    },
  });
  return { menus, events: rootEvents };
}

test("菜单操作打开弹窗前将返回焦点改为入口，普通按钮保持原焦点", () => {
  const {
    menus: [menu],
  } = setup();
  menu.open = true;
  let opened = 0;
  const dialog = {
    showModal() {
      assert.equal(menu.open, false);
      assert.equal(menu.summary.focused, true);
      opened++;
    },
  };
  showDialogFromPopover(dialog, { activeElement: { closest: () => menu } });
  assert.equal(opened, 1);
  let ordinaryOpened = false;
  showDialogFromPopover(
    {
      showModal() {
        ordinaryOpened = true;
      },
    },
    { activeElement: { closest: () => null } }
  );
  assert.equal(ordinaryOpened, true);
});

test("不同入口的菜单互斥，菜单内容交互不关闭自身，外部点击关闭", () => {
  const {
    menus: [first, second],
    events,
  } = setup();
  first.open = true;
  events.click({ target: second.summary });
  assert.equal(first.open, false);
  second.open = true;
  events.click({ target: second.content });
  assert.equal(second.open, true);
  first.open = true;
  first.events.toggle();
  assert.equal(second.open, false);
  events.click({ target: {} });
  assert.equal(first.open, false);
});

test("入口方向键打开菜单并跳过禁用项，表单内部方向键保持原生行为", () => {
  const {
    menus: [menu, other],
    events,
  } = setup();
  let prevented = 0;
  menu.controls[0].matches = () => true;
  const event = {
    key: "ArrowDown",
    target: menu.summary,
    preventDefault: () => prevented++,
  };
  other.open = true;
  events.keydown(event);
  assert.equal(menu.open, true);
  assert.equal(other.open, false);
  assert.equal(menu.controls[0].focused, false);
  assert.equal(menu.controls[2].focused, true);
  menu.controls[0].matches = () => false;
  menu.controls[2].getClientRects = () => [];
  event.key = "ArrowUp";
  events.keydown(event);
  assert.equal(menu.controls[0].focused, true);
  event.target = menu.controls[0];
  events.keydown(event);
  assert.equal(prevented, 2);
});

test("Tab 将焦点移出菜单后关闭，菜单内部切换焦点保持展开", () => {
  const {
    menus: [menu],
    events,
  } = setup();
  menu.open = true;
  events.focusin({ target: menu.controls[0] });
  assert.equal(menu.open, true);
  events.focusin({ target: {} });
  assert.equal(menu.open, false);
  assert.equal(menu.summary.focused, false);
});

test("Escape 关闭菜单并将焦点返回入口，不影响没有菜单的页面", () => {
  const {
    menus: [menu],
    events,
  } = setup();
  let prevented = false;
  const event = {
    key: "Escape",
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation() {},
  };
  events.keydown(event);
  assert.equal(prevented, false);
  menu.open = true;
  events.keydown(event);
  assert.equal(menu.open, false);
  assert.equal(menu.summary.focused, true);
  assert.equal(prevented, true);
});
