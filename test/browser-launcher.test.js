import test from "node:test";
import assert from "node:assert/strict";

import {
  browserLaunchCommand,
  isAllSessionsViewer,
  localViewerUrl,
  openBrowser
} from "../server/browser-launcher.js";

test("本地查看器地址会正确处理 IPv4 和 IPv6", () => {
  assert.equal(localViewerUrl("127.0.0.1", 3210), "http://127.0.0.1:3210");
  assert.equal(localViewerUrl("::1", 3210), "http://[::1]:3210");
});

test("不同系统使用对应的浏览器启动命令", () => {
  assert.deepEqual(browserLaunchCommand("http://127.0.0.1:3210", "win32"), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:3210"]
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

test("只把可识别的 AllSessions 服务视为已运行实例", async () => {
  const accepted = await isAllSessionsViewer("http://127.0.0.1:3210", {
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:3210/api/capabilities");
      assert.equal(options.headers.Accept, "application/json");
      return {
        ok: true,
        async json() {
          return { codex_maintenance: { enabled: false } };
        }
      };
    }
  });
  const rejected = await isAllSessionsViewer("http://127.0.0.1:3210", {
    fetchImpl: async () => ({ ok: true, async json() { return { service: "other" }; } })
  });

  assert.equal(accepted, true);
  assert.equal(rejected, false);
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
