import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

globalThis.localStorage = { getItem: () => null };
const { searchPattern, bindMatchNavigation } =
  await import("../public/search-view.js");
const { regexMatchRanges } = await import("../public/search-highlight.js");

// 以真实线程运行同一份浏览器 Worker，验证超时能终止正在回溯的表达式。
async function createHighlightWorker() {
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     globalThis.self = { postMessage: data => parentPort.postMessage(data) };
     const ready = import(workerData).then(() => parentPort.postMessage({ ready: true }));
     parentPort.on("message", data => ready.then(() => {
       parentPort.postMessage({ started: true });
       self.onmessage({ data });
     }));`,
    {
      eval: true,
      workerData: new URL(
        "../public/search-highlight-worker.js",
        import.meta.url
      ).href,
    }
  );
  // Windows CI 的线程启动与模块加载可能较慢，完成预热后再计量匹配超时。
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeListener("error", fail);
      worker.removeListener("exit", exited);
      worker.removeListener("message", ready);
    };
    const fail = (error) => {
      cleanup();
      void worker.terminate();
      reject(error);
    };
    const exited = (code) => fail(new Error(`高亮线程在就绪前退出：${code}`));
    const ready = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => fail(new Error("高亮线程启动超时")), 15_000);
    worker.once("error", fail);
    worker.once("exit", exited);
    worker.once("message", ready);
  });
  const adapter = {
    started: false,
    postMessage: (data) => worker.postMessage(data),
    terminate: () => void worker.terminate(),
  };
  worker.on("message", (data) => {
    if (data.started) adapter.started = true;
    else adapter.onmessage?.({ data });
  });
  worker.on("error", () => adapter.onerror?.({ preventDefault() {} }));
  return adapter;
}

async function matchInWorker(texts, query) {
  const worker = await createHighlightWorker();
  return regexMatchRanges(texts, query, {
    timeoutMs: 10_000,
    createWorker: () => worker,
  });
}

test("搜索高亮按字面量处理代码符号和中文并保留大小写", () => {
  const text = "HTTP_404 useEffect( 更新";
  assert.deepEqual(
    [...text.matchAll(searchPattern("http_404 useEffect( 更新"))].map(
      (match) => match[0]
    ),
    ["HTTP_404", "useEffect(", "更新"]
  );
  assert.equal(searchPattern("  "), null);
  assert.equal("a+b".match(searchPattern("a+b"))[0], "a+b");
});

test("正则高亮在线程中返回区间并明确报告无效表达式", async () => {
  const texts = ["客服热线 400-1234", "aXb", "无匹配"];
  assert.deepEqual(await matchInWorker(texts, "\\d{3}-\\d{4}|a.b"), [
    [[5, 13]],
    [[0, 3]],
    [],
  ]);
  assert.equal("aXb".match(searchPattern("a.b")), null);
  await assert.rejects(matchInWorker(texts, "(未闭合"), /失败|failed/);
  assert.deepEqual(await matchInWorker(["你好"], "(?=.)"), [[]]);
});

test("灾难性回溯会超时终止且主线程仍响应", async () => {
  let terminated = false;
  let responsive = false;
  const worker = await createHighlightWorker();
  const pending = regexMatchRanges(
    ["a".repeat(32) + "! needle"],
    "(a+)+$|needle",
    {
      timeoutMs: 250,
      createWorker: () => {
        return {
          set onmessage(value) {
            worker.onmessage = value;
          },
          set onerror(value) {
            worker.onerror = value;
          },
          postMessage: worker.postMessage,
          terminate: () => {
            terminated = true;
            worker.terminate();
          },
        };
      },
    }
  );
  const heartbeat = new Promise((resolve) =>
    setTimeout(() => {
      responsive = true;
      resolve();
    }, 10)
  );
  await assert.rejects(pending, /超时|timed out/);
  assert.equal(responsive, true);
  assert.equal(terminated, true);
  assert.equal(
    worker.started,
    true,
    "必须实际开始匹配，不能仅因线程启动慢而超时"
  );
  await heartbeat;
});

test("切换会话可以取消正则任务，过多匹配明确报错", async () => {
  const controller = new AbortController();
  const worker = await createHighlightWorker();
  const pending = regexMatchRanges(["a".repeat(32) + "!"], "(a+)+$", {
    createWorker: () => worker,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(
    matchInWorker(["a".repeat(10_001)], "a"),
    /过多|Too many/
  );
});

test("命中导航从末处向前并循环，空结果禁用按钮", () => {
  const controls = {
    "#detail-search-count": {},
    "#search-previous": {},
    "#search-next": {},
  };
  const positions = [];
  const marks = [0, 1, 2].map((index) => ({
    classList: { add() {}, remove() {} },
    closest: () => null,
    scrollIntoView: () => positions.push(index),
  }));
  globalThis.document = { querySelector: (selector) => controls[selector] };
  try {
    bindMatchNavigation({ querySelectorAll: () => marks });
    controls["#search-previous"].onclick();
    controls["#search-next"].onclick();
    assert.deepEqual(positions, [2, 0]);
    bindMatchNavigation({ querySelectorAll: () => [] });
    assert.equal(controls["#search-next"].disabled, true);
  } finally {
    delete globalThis.document;
  }
});
