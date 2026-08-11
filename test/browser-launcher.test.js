import test from "node:test";
import assert from "node:assert/strict";

import {
  browserLaunchCommand,
  localViewerUrl,
  openBrowser
} from "../server/browser-launcher.js";

test("本地查看器地址会正确处理 IPv4 和 IPv6", () => {
  assert.equal(localViewerUrl("127.0.0.1", 3210), "http://127.0.0.1:3210");
  assert.equal(localViewerUrl("::1", 3210), "http://[::1]:3210");
});

test("不同系统使用对应的浏览器启动命令", () => {
  assert.deepEqual(browserLaunchCommand("http://127.0.0.1:3210", "win32"), {
    command: "explorer.exe",
    args: ["http://127.0.0.1:3210"]
  });
  assert.deepEqual(browserLaunchCommand("http://127.0.0.1:3210", "darwin"), {
    command: "open",
    args: ["http://127.0.0.1:3210"]
  });
  assert.deepEqual(browserLaunchCommand("http://127.0.0.1:3210", "linux"), {
    command: "xdg-open",
    args: ["http://127.0.0.1:3210"]
  });
});

test("启动浏览器后会解除子进程对主进程的引用", () => {
  let received;
  let unrefCalled = false;
  openBrowser("http://127.0.0.1:3210", {
    platform: "linux",
    execFileImpl(command, args, options, callback) {
      received = { command, args, options, callback };
      return { unref() { unrefCalled = true; } };
    }
  });

  assert.equal(received.command, "xdg-open");
  assert.deepEqual(received.args, ["http://127.0.0.1:3210"]);
  assert.deepEqual(received.options, { detached: true, stdio: "ignore", windowsHide: true });
  assert.equal(unrefCalled, true);
  received.callback(null);
});
