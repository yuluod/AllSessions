import test from "node:test";
import assert from "node:assert/strict";

import {
  createLatestRequestGate,
  mapWithConcurrency,
} from "../public/async-coordinator.js";
import { DESKTOP_RUNTIME_REQUIRED, fetchJson } from "../public/api-client.js";
import {
  bindSessionEvents,
  bindTauriSessionEvents,
} from "../public/session-events.js";

class FakeEventBridge {
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

test("并发映射会限制同时执行的任务并保留结果顺序", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([4, 3, 2, 1], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value * 2;
  });

  assert.equal(peak, 2);
  assert.deepEqual(results, [8, 6, 4, 2]);
});

test("Tauri invoke 的不可序列化错误会使用本地化回退", async (t) => {
  const error = {};
  error.self = error;
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async () => {
          throw error;
        },
      },
    },
  };
  t.after(() => {
    delete globalThis.window;
  });

  await assert.rejects(
    fetchJson(
      "/api/test",
      {},
      { formatError: (status) => `fallback:${status}` }
    ),
    (caught) => {
      assert.equal(caught.message, "fallback:500");
      return true;
    }
  );
});

test("缺少 Tauri runtime 时返回稳定错误码", async (t) => {
  globalThis.window = {};
  t.after(() => {
    delete globalThis.window;
  });

  await assert.rejects(fetchJson("/api/test"), (caught) => {
    assert.equal(caught.code, DESKTOP_RUNTIME_REQUIRED);
    return true;
  });
});

test("会话变更会合并为一次 Rust 重查而不是直接拼接本地列表", async () => {
  const eventSource = new FakeEventBridge();
  const added = [];
  let refreshCount = 0;
  const dispose = bindSessionEvents(eventSource, {
    debounceMs: 5,
    refresh: async () => {
      refreshCount += 1;
    },
    onSessionAdded: (summary) => added.push(summary),
  });

  eventSource.emit(
    "session-added",
    JSON.stringify({ _key: "codex:new", cwd: "/tmp/new" })
  );
  eventSource.emit(
    "session-updated",
    JSON.stringify({ _key: "codex:updated" })
  );
  eventSource.emit("session-deleted", JSON.stringify({ id: "codex:deleted" }));

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(refreshCount, 1);
  assert.deepEqual(added, [{ _key: "codex:new", cwd: "/tmp/new" }]);

  dispose();
  eventSource.emit("session-added", JSON.stringify({ _key: "codex:ignored" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(refreshCount, 1);
});

test("损坏的事件数据会被报告，但仍触发一次权威重查", async () => {
  const eventSource = new FakeEventBridge();
  const errors = [];
  let refreshCount = 0;
  bindSessionEvents(eventSource, {
    debounceMs: 5,
    refresh: () => {
      refreshCount += 1;
    },
    onMalformed: (error) => errors.push(error),
  });

  eventSource.emit("session-updated", "not-json");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(errors.length, 1);
  assert.equal(refreshCount, 1);
});

test("Tauri sessions-changed 事件会进入统一去抖刷新流程", async (t) => {
  let listener;
  let unlistenCount = 0;
  globalThis.window = {
    __TAURI__: {
      event: {
        listen: async (name, handler) => {
          assert.equal(name, "sessions-changed");
          listener = handler;
          return () => {
            unlistenCount += 1;
          };
        },
      },
    },
  };
  t.after(() => {
    delete globalThis.window;
  });
  let refreshCount = 0;
  const added = [];
  const dispose = await bindTauriSessionEvents({
    debounceMs: 5,
    refresh: () => {
      refreshCount += 1;
    },
    onSessionAdded: (summary) => added.push(summary),
  });
  listener({ payload: { type: "session-added", summary: { id: "new" } } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(refreshCount, 1);
  assert.deepEqual(added, [{ id: "new" }]);
  dispose();
  assert.equal(unlistenCount, 1);
});
