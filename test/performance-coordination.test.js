import test from "node:test";
import assert from "node:assert/strict";
import { createRefreshCoordinator } from "../public/async-coordinator.js";
import { createReadScheduler, readLane } from "../public/read-scheduler.js";
import { createBoundedCache } from "../public/bounded-cache.js";
import { planMessageUpdates } from "../public/message-reconciliation.js";
import {
  changeSessionSelection,
  invalidateQuery,
  applySessionPage,
} from "../public/workspace-state.js";
import {
  performanceSnapshot,
  resetPerformanceMetrics,
  recordMetric,
} from "../public/performance-metrics.js";
import { fetchJson } from "../public/api-client.js";

test("只读 IPC 取消通知后端，写请求不携带取消标识", async (t) => {
  const original = globalThis.window;
  t.after(() => {
    globalThis.window = original;
  });
  const calls = [];
  let finish;
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke(command, args) {
          calls.push({ command, args });
          if (command === "cancel_read_request") return Promise.resolve();
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    },
  };
  const controller = new AbortController();
  const read = fetchJson("/api/search?q=synthetic", {
    signal: controller.signal,
  });
  const rejected = assert.rejects(read, { name: "AbortError" });
  controller.abort();
  finish({ sessions: [] });
  await rejected;
  assert.equal(calls[1].command, "cancel_read_request");
  assert.equal(calls[1].args.requestId, calls[0].args.request.requestId);
  const writeController = new AbortController();
  const write = fetchJson("/api/settings", {
    method: "POST",
    body: {},
    signal: writeController.signal,
  });
  const writeRejected = assert.rejects(write, { name: "AbortError" });
  writeController.abort();
  finish({ ok: true });
  await writeRejected;
  assert.equal(calls.length, 3);
  assert.equal(calls[2].args.request.requestId, undefined);
});

test("刷新中继续变更只补一轮，独立范围合并且失败后仍可重试", async () => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const batches = [];
  const refresh = createRefreshCoordinator(async (scopes) => {
    batches.push([...scopes]);
    if (batches.length === 1) await wait;
  });
  const first = refresh(["sessions"]);
  await Promise.resolve();
  for (let i = 0; i < 100; i++) refresh(["stats", "facets"]);
  release();
  await first;
  assert.deepEqual(batches, [["sessions"], ["stats", "facets"]]);
  let fail = true;
  const retry = createRefreshCoordinator(async () => {
    if (fail) throw new Error("失败");
  });
  await assert.rejects(retry(["sessions"]));
  fail = false;
  await retry(["sessions"]);
});

test("只读队列丢弃中间请求，写操作不参与替代", async () => {
  const schedule = createReadScheduler();
  let release;
  const calls = [];
  const first = schedule(
    "search",
    () =>
      new Promise((resolve) => {
        calls.push(1);
        release = resolve;
      }),
    new AbortController().signal
  );
  const second = schedule(
    "search",
    async () => calls.push(2),
    new AbortController().signal
  );
  const rejected = assert.rejects(second, { name: "AbortError" });
  const third = schedule(
    "search",
    async () => calls.push(3),
    new AbortController().signal
  );
  await schedule(
    readLane("/api/sessions/delete", "POST"),
    async () => calls.push("write"),
    new AbortController().signal
  );
  release();
  await Promise.all([first, third, rejected]);
  assert.deepEqual(calls, [1, "write", 3]);
  assert.equal(readLane("/api/refresh"), null);
});

test("等待期间取消不会执行任务，通道释放后能继续请求", async () => {
  const schedule = createReadScheduler();
  let release;
  const first = schedule(
    "detail",
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    new AbortController().signal
  );
  const controller = new AbortController();
  const second = schedule(
    "detail",
    () => assert.fail("不应执行"),
    controller.signal
  );
  const rejected = assert.rejects(second, { name: "AbortError" });
  controller.abort();
  release();
  await Promise.all([first, rejected]);
  assert.equal(
    await schedule("detail", async () => 42, new AbortController().signal),
    42
  );
});

test("消息更新计划仅替换变化消息，语言及检索变化失效复用", () => {
  const groups = Array.from({ length: 800 }, (_, i) => ({
    message: { _message_key: String(i), text: "合成正文", _origIdx: i },
  }));
  const context = { lang: "zh", query: "", regex: false };
  const cache = new Map(
    planMessageUpdates(groups, new Map(), context).map((entry) => [
      entry.key,
      entry,
    ])
  );
  groups[799].message.text = "新正文";
  const updates = planMessageUpdates(groups, cache, context);
  assert.equal(updates.filter((entry) => !entry.reuse).length, 1);
  assert.equal(
    planMessageUpdates(groups, cache, { ...context, lang: "en" }).filter(
      (entry) => entry.reuse
    ).length,
    0
  );
  assert.equal(
    planMessageUpdates(groups, cache, { ...context, query: "关键词" }).filter(
      (entry) => entry.reuse
    ).length,
    0
  );
  assert.equal(
    planMessageUpdates(groups, cache, { ...context, regex: true }).filter(
      (entry) => entry.reuse
    ).length,
    0
  );
});

test("缓存按容量和最近使用淘汰，超大条目不占缓存", () => {
  const cache = createBoundedCache({ maxEntries: 2, maxBytes: 10 });
  cache.set("a", 1, 4);
  cache.set("b", 2, 4);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3, 4);
  assert.equal(cache.get("b"), undefined);
  cache.set("huge", 9, 11);
  assert.equal(cache.size, 2);
  assert.equal(cache.bytes, 8);
  cache.clear();
  assert.equal(cache.bytes, 0);
});

test("查询和会话切换入口统一取消、清分页并接收权威总数", () => {
  const state = {
    nextCursor: "old",
    hasMore: true,
    currentDetail: {},
    statsDirty: false,
  };
  let cancelled = 0;
  const gate = { cancel: () => cancelled++ };
  invalidateQuery(state, [gate]);
  assert.equal(state.nextCursor, null);
  assert.equal(state.statsDirty, true);
  changeSessionSelection(state, "new", { ordinal: 2 }, gate);
  assert.equal(state.currentDetail, null);
  assert.equal(state.selectedSearchHit.sessionKey, "new");
  applySessionPage(state, { sessions: [], total: 10, has_more: false }, false);
  assert.equal(state.sessionsTotal, 10);
  assert.equal(cancelled, 2);
});

test("性能采样输出聚合数值，不暴露请求内容", () => {
  resetPerformanceMetrics();
  for (let i = 0; i < 1000; i++) recordMetric("test.duration_ms", i);
  const result = performanceSnapshot()["test.duration_ms"];
  assert.equal(result.count, 1000);
  assert.equal(result.max, 999);
  assert.ok(result.p95 >= 990);
  assert.equal(Object.hasOwn(result, "recent"), false);
});
