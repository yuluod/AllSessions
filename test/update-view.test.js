import test from "node:test";
import assert from "node:assert/strict";

import {
  progressPercent,
  shouldShowAvailableVersion,
} from "../public/update-state.js";

globalThis.localStorage = { getItem: () => null };
const { createUpdateController } = await import("../public/update-view.js");

test("更新下载进度限制在有效百分比范围内", () => {
  assert.equal(progressPercent(25, 100), 25);
  assert.equal(progressPercent(150, 100), 100);
  assert.equal(progressPercent(-10, 100), 0);
});

test("未知安装包大小使用不确定进度", () => {
  assert.equal(progressPercent(20, null), null);
  assert.equal(progressPercent(20, 0), null);
});

test("仅在存在待安装版本时显示可用版本标题", () => {
  assert.equal(shouldShowAvailableVersion("available", "0.0.24"), true);
  assert.equal(shouldShowAvailableVersion("downloading", "0.0.24"), true);
  assert.equal(shouldShowAvailableVersion("ready", "0.0.24"), true);
  assert.equal(shouldShowAvailableVersion("installing", "0.0.24"), true);
  assert.equal(shouldShowAvailableVersion("install_error", "0.0.24"), true);
  assert.equal(shouldShowAvailableVersion("latest", "0.0.23"), false);
  assert.equal(shouldShowAvailableVersion("available", ""), false);
});

test("可恢复安装错误直接重试安装，其余错误重新检查更新", async (t) => {
  const primary = Object.assign(new EventTarget(), {
    dataset: {},
    classList: { toggle() {} },
  });
  const root = {
    querySelector: (selector) =>
      selector === "#update-primary-btn" ? primary : null,
  };
  const calls = [];
  const previousWindow = globalThis.window;
  globalThis.window = {};
  t.after(() => {
    globalThis.window = previousWindow;
  });
  const controller = createUpdateController({
    root,
    requestJson: (url) => calls.push(url),
  });
  await controller.bind();
  for (const phase of ["install_error", "error"]) {
    controller.handleStatus({ phase });
    primary.dispatchEvent(new Event("click"));
  }
  assert.deepEqual(calls, [
    "/api/settings/install-update",
    "/api/settings/check-update",
  ]);
});

test("后台下载结果在打开的设置内可查看，在主界面沿用提示", async (t) => {
  class Element extends EventTarget {
    open = false;
    hidden = true;
    dataset = {};
    classList = { add() {}, remove() {}, toggle() {} };

    showModal() {
      this.open = true;
    }
  }

  const dialog = new Element();
  const settings = new Element();
  const notice = new Element();
  const message = new Element();
  const details = new Element();
  const elements = {
    "#update-dialog": dialog,
    "#settings-dialog": settings,
    "#settings-update-result": notice,
    "#settings-update-result-text": message,
    "#settings-update-result-action": details,
  };
  const document = {
    documentElement: new Element(),
    querySelector: (selector) => elements[selector] ?? null,
  };
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = document;
  globalThis.window = {};
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  });

  const announced = [];
  const controller = createUpdateController({
    root: document,
    announce: (...args) => announced.push(args),
  });
  await controller.bind();

  settings.open = true;
  controller.handleStatus({ phase: "downloading" });
  controller.handleStatus({ phase: "ready" });
  assert.equal(notice.hidden, false);
  assert.ok(message.textContent);
  assert.equal(announced.length, 0);
  details.dispatchEvent(new Event("click"));
  assert.equal(dialog.open, true);

  dialog.open = false;
  settings.open = false;
  controller.handleStatus({ phase: "downloading" });
  assert.equal(notice.hidden, true);
  controller.handleStatus({ phase: "error" });
  assert.equal(announced.length, 1);
  announced[0][1].onAction();
  assert.equal(dialog.open, true);
});
