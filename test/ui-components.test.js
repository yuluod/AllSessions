import assert from "node:assert/strict";
import test from "node:test";
import { bindPopoverMenus } from "../public/ui-components.js";

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
