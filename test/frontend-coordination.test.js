import test from "node:test";
import assert from "node:assert/strict";

import { createLatestRequestGate } from "../public/async-coordinator.js";
import { bindSessionEvents } from "../public/session-events.js";

class FakeEventSource {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, data) {
    for (const listener of this.listeners.get(type) || []) {
      listener({ data });
    }
  }
}

test("后发请求会使先前请求失效并中止其网络信号", () => {
  const gate = createLatestRequestGate();
  const first = gate.begin();
  const second = gate.begin();

  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.signal.aborted, false);
  assert.equal(second.isCurrent(), true);

  gate.cancel();
  assert.equal(second.signal.aborted, true);
  assert.equal(second.isCurrent(), false);
});

test("SSE 变更会合并为一次服务端重查而不是直接拼接本地列表", async () => {
  const eventSource = new FakeEventSource();
  const added = [];
  let refreshCount = 0;
  const dispose = bindSessionEvents(eventSource, {
    debounceMs: 5,
    refresh: async () => {
      refreshCount += 1;
    },
    onSessionAdded: (summary) => added.push(summary)
  });

  eventSource.emit("session-added", JSON.stringify({ _key: "codex:new", cwd: "/tmp/new" }));
  eventSource.emit("session-updated", JSON.stringify({ _key: "codex:updated" }));
  eventSource.emit("session-deleted", JSON.stringify({ id: "codex:deleted" }));

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(refreshCount, 1);
  assert.deepEqual(added, [{ _key: "codex:new", cwd: "/tmp/new" }]);

  dispose();
  eventSource.emit("session-added", JSON.stringify({ _key: "codex:ignored" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(refreshCount, 1);
});

test("损坏的 SSE 数据会被报告，但仍触发一次权威重查", async () => {
  const eventSource = new FakeEventSource();
  const errors = [];
  let refreshCount = 0;
  bindSessionEvents(eventSource, {
    debounceMs: 5,
    refresh: () => {
      refreshCount += 1;
    },
    onMalformed: (error) => errors.push(error)
  });

  eventSource.emit("session-updated", "not-json");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(errors.length, 1);
  assert.equal(refreshCount, 1);
});
