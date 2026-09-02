import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveMaintenanceState,
  sameProviderSelection,
} from "../public/maintenance-state.js";

globalThis.localStorage = {
  getItem: () => "zh",
  setItem: () => {},
};

const { createMaintenanceController } =
  await import("../public/maintenance-view.js");

function createEventElement() {
  const listeners = new Map();
  const classes = new Set();
  return {
    checked: false,
    disabled: false,
    textContent: "",
    dataset: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle(name, force) {
        if (force === undefined ? !classes.has(name) : force) classes.add(name);
        else classes.delete(name);
      },
    },
    addEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    async emit(type) {
      const event = { currentTarget: this, target: this };
      await Promise.all(
        (listeners.get(type) || []).map((listener) => listener(event))
      );
    },
    closest: () => null,
  };
}

function createMaintenanceRoot() {
  const maintenanceToggle = createEventElement();
  const previewBtn = createEventElement();
  const status = createEventElement();
  const elements = new Map([
    ["#codex-maintenance-toggle", maintenanceToggle],
    ["#codex-migration-preview-btn", previewBtn],
    ["#codex-migration-status", status],
  ]);
  return {
    maintenanceToggle,
    previewBtn,
    root: {
      querySelector: (selector) => elements.get(selector) || null,
      querySelectorAll: () => [],
    },
  };
}

const applicablePreview = {
  candidateMappings: [{ source: "custom", target: "openai" }],
  providers: ["custom"],
  canApply: true,
  hasChanges: true,
  planId: "plan-1",
};

test("Provider 选择比较不受顺序影响", () => {
  assert.equal(
    sameProviderSelection(["custom-b", "custom-a"], ["custom-a", "custom-b"]),
    true
  );
  assert.equal(sameProviderSelection(["custom-a"], ["custom-b"]), false);
});

test("维护流程从关闭状态进入扫描和来源选择", () => {
  assert.deepEqual(deriveMaintenanceState().phase, "disabled");

  const scan = deriveMaintenanceState({ enabled: true });
  assert.equal(scan.phase, "scan");
  assert.equal(scan.activeStep, 2);
  assert.equal(scan.nextStepKey, "nextStepScanProviders");

  const select = deriveMaintenanceState({
    enabled: true,
    preview: applicablePreview,
  });
  assert.equal(select.phase, "select");
  assert.equal(select.previewButtonKey, "buildExactRepairPlan");
  assert.equal(select.nextStepKey, "nextStepSelectProviders");
});

test("来源选择变化会使旧计划失效并禁止执行", () => {
  const flow = deriveMaintenanceState({
    enabled: true,
    preview: applicablePreview,
    selectedProviders: ["another-provider"],
    confirmed: true,
  });

  assert.equal(flow.stale, true);
  assert.equal(flow.phase, "select");
  assert.equal(flow.nextStepKey, "nextStepRebuildPlan");
  assert.equal(flow.controls.applyDisabled, true);
});

test("有效计划必须确认 Codex 已关闭后才能执行", () => {
  const unconfirmed = deriveMaintenanceState({
    enabled: true,
    preview: applicablePreview,
    selectedProviders: ["custom"],
  });
  assert.equal(unconfirmed.phase, "execute");
  assert.equal(unconfirmed.nextStepKey, "nextStepConfirmClosed");
  assert.equal(unconfirmed.controls.applyDisabled, true);

  const confirmed = deriveMaintenanceState({
    enabled: true,
    preview: applicablePreview,
    selectedProviders: ["custom"],
    confirmed: true,
  });
  assert.equal(confirmed.nextStepKey, "nextStepApplyPlan");
  assert.equal(confirmed.controls.applyDisabled, false);
});

test("阻塞、无变更和完成状态映射到正确流程阶段", () => {
  const blocked = deriveMaintenanceState({
    enabled: true,
    preview: { ...applicablePreview, canApply: false },
    selectedProviders: ["custom"],
  });
  assert.equal(blocked.phase, "review");
  assert.equal(blocked.nextStepKey, "nextStepResolveBlockers");

  const unchanged = deriveMaintenanceState({
    enabled: true,
    preview: { ...applicablePreview, hasChanges: false },
    selectedProviders: ["custom"],
  });
  assert.equal(unchanged.phase, "review");
  assert.equal(unchanged.nextStepKey, "nextStepNoChanges");

  const complete = deriveMaintenanceState({ enabled: true, applied: true });
  assert.equal(complete.phase, "complete");
  assert.equal(complete.activeStep, 5);
  assert.equal(complete.nextStepKey, "nextStepRepairDone");
  assert.equal(complete.controls.finishDisabled, false);
});

test("预览忙碌时仍允许关闭维护模式，但锁定其他操作", () => {
  const flow = deriveMaintenanceState({
    enabled: true,
    busy: true,
    allowMaintenanceToggle: true,
  });

  assert.equal(flow.controls.maintenanceToggleDisabled, false);
  assert.equal(flow.controls.previewDisabled, true);
  assert.equal(flow.controls.applyDisabled, true);
  assert.equal(flow.controls.rollbackDisabled, true);
});

test("关闭维护模式会取消进行中的预览并提交关闭请求", async () => {
  const { root, maintenanceToggle, previewBtn } = createMaintenanceRoot();
  const calls = [];
  let previewSignal;
  const requestJson = (url, options = {}) => {
    calls.push({ url, options });
    if (url.startsWith("/api/codex-provider-migration/preview")) {
      previewSignal = options.signal;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });
    }
    if (url === "/api/codex-maintenance") {
      return Promise.resolve({ enabled: false });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const controller = createMaintenanceController({
    requestJson,
    refreshData: async () => {},
    root,
  });
  controller.bind();
  controller.setCapabilities({ codex_maintenance: { enabled: true } });

  const preview = previewBtn.emit("click");
  assert.ok(previewSignal instanceof AbortSignal);
  assert.equal(previewSignal.aborted, false);
  assert.equal(maintenanceToggle.disabled, false);

  maintenanceToggle.checked = false;
  const toggle = maintenanceToggle.emit("change");
  await Promise.all([preview, toggle]);

  assert.equal(previewSignal.aborted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/api/codex-provider-migration/preview");
  assert.equal(calls[0].options.signal, previewSignal);
  assert.equal(calls[1].url, "/api/codex-maintenance");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.mutation, true);
  assert.deepEqual(JSON.parse(calls[1].options.body), { enabled: false });
});
