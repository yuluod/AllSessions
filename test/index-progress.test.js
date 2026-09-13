import test from "node:test";
import assert from "node:assert/strict";
import { createIndexProgressPoller } from "../public/index-progress.js";

function fixture(read) {
  const timers = new Map();
  const statuses = [];
  const errors = [];
  let visible = true;
  let id = 0;
  const poller = createIndexProgressPoller({
    read,
    render: (value) => statuses.push(value),
    onError: (error) => errors.push(error),
    isVisible: () => visible,
    schedule: (callback, delay) => {
      timers.set(++id, { callback, delay });
      return id;
    },
    cancel: (key) => timers.delete(key),
  });
  return {
    poller,
    timers,
    statuses,
    errors,
    hide: () => {
      visible = false;
    },
    show: () => {
      visible = true;
    },
  };
}

test("仅扫描与索引阶段继续轮询，终态停止", async () => {
  let phase = "scanning";
  const f = fixture(async () => ({ phase }));
  for (phase of ["scanning", "indexing", "ready", "error"]) {
    await f.poller.refresh();
    assert.equal(
      f.timers.size,
      ["scanning", "indexing"].includes(phase) ? 1 : 0
    );
  }
});

test("隐藏暂停，恢复可见后重新读取", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { phase: "indexing" };
  });
  await f.poller.refresh();
  f.hide();
  await f.poller.refresh();
  assert.equal(f.timers.size, 0);
  assert.equal(calls, 1);
  f.show();
  await f.poller.refresh();
  assert.equal(calls, 2);
});

test("请求中收到事件不并发，但完成后补读最新状态", async () => {
  let resolve;
  let calls = 0;
  const f = fixture(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const first = f.poller.refresh();
  await f.poller.refresh();
  await f.poller.refresh();
  assert.equal(calls, 1);
  resolve({ phase: "ready" });
  await first;
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 0);
});

test("隐藏期间完成的请求不渲染也不重启计时", async () => {
  let resolve;
  const f = fixture(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const request = f.poller.refresh();
  f.hide();
  await f.poller.refresh();
  resolve({ phase: "indexing" });
  await request;
  assert.equal(f.statuses.length, 0);
  assert.equal(f.timers.size, 0);
});

test("请求失败明确报告且不永久重试", async () => {
  const f = fixture(async () => {
    throw new Error("连接失败");
  });
  await f.poller.refresh();
  assert.equal(f.errors.length, 1);
  assert.equal(f.timers.size, 0);
});
