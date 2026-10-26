import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

const { summarizeSourceSupport } = await import("../public/settings-view.js");

test("重新扫描只更新诊断视图而不覆盖设置草稿", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../public/settings-view.js", import.meta.url),
    "utf8"
  );
  const rescan = source.slice(
    source.indexOf("async function rescanSources()"),
    source.indexOf("async function checkForUpdates()")
  );
  assert.doesNotMatch(rescan, /applyPayload|draft\s*=|renderPreferences/);
  assert.match(rescan, /renderSources\(latestPayload\)/);
  assert.match(rescan, /renderDiagnostics\(latestPayload\)/);
});

test("来源概览按 Agent 去重并统计当前检测结果", () => {
  const result = summarizeSourceSupport({
    diagnostics: {
      sources: {
        codex: { enabled: true, available_roots: 1 },
        codex_archived: { enabled: true, available_roots: 1 },
        claude: { enabled: true, available_roots: 0 },
        opencode: { enabled: true, available_roots: 1 },
      },
    },
  });

  assert.deepEqual(result, { supported: 15, detected: 2 });
});

const { cloneSourceSettings, hasSourceChanges, sourceHealthState } =
  await import("../public/settings-view.js");

test("编辑目录草稿不会修改保存基线，恢复原值后不再需要保存", () => {
  const saved = { codex: ["/demo/default", "/demo/extra"], claude: null };
  const draft = cloneSourceSettings(saved);
  draft.codex[1] = "/demo/edited";
  assert.deepEqual(saved.codex, ["/demo/default", "/demo/extra"]);
  assert.equal(hasSourceChanges(draft, saved), true);
  draft.codex[1] = "/demo/extra";
  assert.equal(hasSourceChanges(draft, saved), false);
});

test("来源更改区分继承、停用、目录顺序及空输入，不依赖对象键顺序", () => {
  assert.equal(hasSourceChanges({ codex: null }, {}), false);
  assert.equal(hasSourceChanges({ codex: [] }, {}), true);
  assert.equal(hasSourceChanges({ codex: [""] }, {}), true);
  assert.equal(
    hasSourceChanges({ codex: ["/b", "/a"] }, { codex: ["/a", "/b"] }),
    true
  );
  assert.equal(
    hasSourceChanges({ claude: null, codex: ["/a"] }, { codex: ["/a"] }),
    false
  );
});

test("来源健康状态区分未取得诊断、停用、读取异常和可用", () => {
  assert.equal(sourceHealthState(), "unknown");
  assert.equal(sourceHealthState({}), "unknown");
  assert.equal(sourceHealthState({ enabled: false }), "disabled");
  assert.equal(
    sourceHealthState({ enabled: true, error_count: 1, available_roots: 1 }),
    "warning"
  );
  assert.equal(
    sourceHealthState({
      enabled: true,
      unsupported_count: 1,
      available_roots: 1,
    }),
    "unsupported"
  );
  assert.equal(
    sourceHealthState({ enabled: true, available_roots: 0 }),
    "missing"
  );
  assert.equal(
    sourceHealthState({ enabled: true, available_roots: 1 }),
    "ready"
  );
});

test("设置加载期间可以关闭，旧请求不能覆盖重新打开后的内容", async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const responses = [];
  const target = {
    open: false,
    setAttribute() {},
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  };
  globalThis.document = {
    documentElement: { classList: { add() {}, remove() {} } },
  };
  globalThis.window = {
    __TAURI__: {
      core: { invoke: () => new Promise((resolve) => responses.push(resolve)) },
    },
  };
  try {
    const { createSettingsController } =
      await import("../public/settings-view.js");
    const version = { textContent: "" };
    const save = { disabled: false };
    const controller = createSettingsController({
      elements: {
        settingsDialog: target,
        settingsVersion: version,
        settingsSaveBtn: save,
      },
    });
    const first = controller.open();
    assert.equal(target.open, true);
    controller.close();
    assert.equal(target.open, false);
    const second = controller.open();
    responses[1]({ version: "new", sources: { codex: ["/demo/new"] } });
    await second;
    assert.equal(version.textContent, "new");
    responses[0]({ version: "old", sources: { codex: ["/demo/old"] } });
    await first;
    assert.equal(version.textContent, "new");
    assert.equal(save.disabled, true);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

async function exerciseIconRestart({
  confirmed = false,
  available = true,
  saveError,
  restartError,
} = {}) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const calls = [];
  const status = { textContent: "", dataset: {} };
  const target = {
    open: false,
    setAttribute() {},
    addEventListener() {},
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  };
  const inputs = ["default", "amber"].map((value) => ({
    value,
    checked: false,
    listeners: new Map(),
    addEventListener(name, handler) {
      this.listeners.set(name, handler);
    },
  }));
  globalThis.document = {
    documentElement: { classList: { add() {}, remove() {} } },
    addEventListener() {},
  };
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async (_command, { request }) => {
          calls.push({
            url: request.url,
            method: request.method,
            body: request.body,
          });
          if (request.url === "/api/settings") {
            return { sources: {}, preferences: { app_icon: "default" } };
          }
          if (request.url === "/api/settings/preferences") {
            if (saveError) throw new Error(saveError);
            return {
              preferences: request.body.preferences,
              app_icon_restart_available: available,
            };
          }
          if (request.url === "/api/settings/restart") {
            if (restartError) throw new Error(restartError);
            return { ok: true };
          }
          throw new Error(`意外请求：${request.url}`);
        },
      },
    },
  };
  try {
    const { createSettingsController } =
      await import("../public/settings-view.js");
    const controller = createSettingsController({
      elements: {
        settingsDialog: target,
        settingsAppIconInputs: inputs,
        settingsStatus: status,
      },
      confirmRestart: async (message, options) => {
        calls.push({ url: "confirm", message, options });
        return confirmed;
      },
    });
    controller.bind();
    await controller.open();
    inputs[0].checked = false;
    inputs[1].checked = true;
    await inputs[1].listeners.get("change")();
    return { calls, status, inputs };
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
}

test("图标保存后选择立即重启才发送确认后的重启请求", async () => {
  const { calls } = await exerciseIconRestart({ confirmed: true });
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      "/api/settings",
      "/api/settings/preferences",
      "confirm",
      "/api/settings/restart",
    ]
  );
  assert.equal(calls[1].body.preferences.app_icon, "amber");
  assert.deepEqual(calls[3].body, { confirmed: true });
  assert.equal(calls[3].method, "POST");
  assert.ok(calls[2].options.okLabel);
  assert.ok(calls[2].options.cancelLabel);
});

test("选择稍后保留新图标偏好且不重启", async () => {
  const { calls, inputs } = await exerciseIconRestart();
  assert.equal(calls.filter(({ url }) => url === "confirm").length, 1);
  assert.equal(
    calls.some(({ url }) => url === "/api/settings/restart"),
    false
  );
  assert.equal(inputs[1].checked, true);
  assert.equal(inputs[1].disabled, false);
});

test("无需重启提示或图标保存失败时不弹窗也不重启", async () => {
  for (const options of [{ available: false }, { saveError: "保存失败" }]) {
    const { calls } = await exerciseIconRestart({
      ...options,
      confirmed: true,
    });
    assert.equal(
      calls.some(({ url }) => url === "confirm"),
      false
    );
    assert.equal(
      calls.some(({ url }) => url === "/api/settings/restart"),
      false
    );
  }
});

test("重启请求失败明确显示错误且保留已保存的图标", async () => {
  const { status, inputs } = await exerciseIconRestart({
    confirmed: true,
    restartError: "重启请求失败",
  });
  assert.equal(status.dataset.state, "error");
  assert.match(status.textContent, /重启请求失败/);
  assert.equal(inputs[1].checked, true);
});
