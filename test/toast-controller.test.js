import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createToastController } from "../public/toast-controller.js";
import { createLatestRequestGate } from "../public/async-coordinator.js";

function setup() {
  let time = 0;
  let serial = 0;
  const timers = new Map();
  const document = { activeElement: null };
  class Element {
    constructor() {
      this.children = [];
      this.events = {};
      this.attributes = new Map();
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
    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
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
  const status = new Element();
  const origin = new Element();
  const fallback = new Element();
  document.activeElement = origin;
  document.createElement = () => new Element();
  document.querySelector = (selector) => {
    if (selector === ".page-shell") return shell;
    if (selector === "#aria-live") return status;
    return fallback;
  };
  document.querySelectorAll = () => [];
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
    status,
    stack: () => shell.children[0],
    toasts: () => shell.children[0].children,
  };
}

test("提示排队和合并时仍立即更新独立播报区域，出队时不重复播报", async () => {
  const ui = setup();
  const source = (
    await readFile(new URL("../public/app/shared.js", import.meta.url), "utf8")
  )
    .replace(/^import[\s\S]*?from\s+"[^"]+";\s*/gm, "")
    .replace(/^export \{[^}]*\} from "[^"]+";\s*/gm, "")
    .replace(/^export /gm, "");
  const app = vm.createContext({
    document: ui.document,
    createLatestRequestGate,
    createToastController: () => ui.show,
  });
  vm.runInContext(source, app);
  app.announce("备份一", { sticky: true });
  app.announce("备份二", { sticky: true });
  app.announce("已收藏");
  assert.equal(ui.status.textContent, "已收藏");
  app.announce("已保存备注");
  assert.equal(ui.status.textContent, "已保存备注");
  assert.deepEqual(
    ui.toasts().map((toast) => toast.children[0].textContent),
    ["备份一", "备份二"]
  );
  assert.equal(ui.stack().attributes.has("aria-live"), false);
  ui.toasts()[0].children.at(-1).events.click();
  assert.deepEqual(
    ui.toasts().map((toast) => toast.children[0].textContent),
    ["备份二", "已保存备注"]
  );
  assert.equal(ui.status.textContent, "已保存备注");
});

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
