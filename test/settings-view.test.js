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

  assert.deepEqual(result, { supported: 13, detected: 2 });
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
