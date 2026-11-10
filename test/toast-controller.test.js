import assert from "node:assert/strict";
import test from "node:test";
import { createToastController } from "../public/toast-controller.js";

function setup() {
  let time = 0;
  let serial = 0;
  const timers = new Map();
  const document = { activeElement: null };
  class Element {
    constructor() {
      this.children = [];
      this.events = {};
      this.isConnected = true;
    }
    append(...children) {
      children.forEach((child) => {
        child.parent = this;
        this.children.push(child);
      });
    }
    remove() {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.isConnected = false;
    }
    contains(element) {
      return (
        element === this ||
        this.children.some((child) => child.contains(element))
      );
    }
    setAttribute() {}
    matches() {
      return false;
    }
    getClientRects() {
      return [{}];
    }
    addEventListener(name, handler) {
      this.events[name] = handler;
    }
    focus() {
      document.activeElement = this;
    }
  }
  const shell = new Element();
  const origin = new Element();
  const fallback = new Element();
  document.activeElement = origin;
  document.createElement = () => new Element();
  document.querySelector = (selector) =>
    selector === ".page-shell" ? shell : fallback;
  const show = createToastController({
    document,
    dismissLabel: () => "关闭",
    createDismissIcon: () => new Element(),
    now: () => time,
    schedule: (callback, delay) => {
      timers.set(++serial, { callback, at: time + delay });
      return serial;
    },
    cancel: (id) => timers.delete(id),
  });
  const advance = (ms) => {
    time += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= time) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  return {
    show,
    document,
    origin,
    fallback,
    advance,
    timers,
    toasts: () => shell.children[0].children,
  };
}

test("两条重要提示占满时普通提示等待，且只保留最新的普通提示", () => {
  const ui = setup();
  ui.show("备份", { sticky: true });
  ui.show("撤销", { actionLabel: "撤销", onAction() {} });
  ui.show("旧状态");
  ui.show("新状态");
  assert.deepEqual(
    ui.toasts().map((toast) => toast.children[0].textContent),
    ["备份", "撤销"]
  );
  ui.toasts()[0].children.at(-1).events.click();
  assert.deepEqual(
    ui.toasts().map((toast) => toast.children[0].textContent),
    ["撤销", "新状态"]
  );
});

test("重要提示按顺序排队，不被新的普通提示挤掉", () => {
  const ui = setup();
  for (const message of ["一", "二", "三"]) ui.show(message, { sticky: true });
  ui.show("普通");
  ui.toasts()[0].children.at(-1).events.click();
  assert.deepEqual(
    ui.toasts().map((toast) => toast.children[0].textContent),
    ["二", "三"]
  );
});

test("动作获得焦点时暂停计时，关闭后返回原入口，离焦微任务不会复活计时器", async () => {
  const ui = setup();
  let actions = 0;
  ui.show("可撤销", { actionLabel: "撤销", onAction: () => actions++ });
  const toast = ui.toasts()[0];
  ui.advance(1000);
  toast.children[1].focus();
  toast.events.focusin();
  ui.advance(20000);
  assert.equal(ui.toasts().length, 1);
  toast.events.focusout();
  toast.children[1].events.click();
  await Promise.resolve();
  assert.equal(actions, 1);
  assert.equal(ui.document.activeElement, ui.origin);
  assert.equal(ui.timers.size, 0);
});

test("悬停暂停并在离开后继续剩余时长，不抢走其他控件的焦点", () => {
  const ui = setup();
  ui.show("完成", { duration: 4500 });
  const toast = ui.toasts()[0];
  ui.advance(1000);
  toast.events.pointerenter();
  ui.advance(10000);
  toast.events.pointerleave();
  ui.advance(3499);
  assert.equal(ui.toasts().length, 1);
  ui.advance(1);
  assert.equal(ui.toasts().length, 0);
  assert.equal(ui.document.activeElement, ui.origin);
});

test("原入口已经消失时，关闭提示把焦点交还有效的后备入口", () => {
  const ui = setup();
  ui.show("完成", { sticky: true });
  ui.origin.isConnected = false;
  const close = ui.toasts()[0].children.at(-1);
  close.focus();
  close.events.click();
  assert.equal(ui.document.activeElement, ui.fallback);
});
