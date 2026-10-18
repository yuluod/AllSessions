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
    return {
      open: false,
      summary,
      content,
      events,
      contains: (target) => target === summary || target === content,
      querySelector: () => summary,
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
