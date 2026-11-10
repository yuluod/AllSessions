// 无真实会话、无 IPC 的合成调度基线；数值不代表桌面端耗时。
import { performance } from "node:perf_hooks";
import { createReadScheduler } from "../public/read-scheduler.js";
import { createRefreshCoordinator } from "../public/async-coordinator.js";
import { planMessageUpdates } from "../public/message-reconciliation.js";
const schedule = createReadScheduler();
let release;
let dispatched = 0;
const promises = [
  schedule(
    "search",
    () => {
      dispatched++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    new AbortController().signal
  ),
];
for (let i = 1; i < 100; i++)
  promises.push(
    schedule(
      "search",
      async () => {
        dispatched++;
      },
      new AbortController().signal
    ).catch((error) => {
      if (error.name !== "AbortError") throw error;
    })
  );
release();
await Promise.all(promises);
let rounds = 0;
const refresh = createRefreshCoordinator(async () => {
  rounds++;
});
await Promise.all(
  Array.from({ length: 100 }, () => refresh(["sessions", "stats"]))
);
const groups = Array.from({ length: 800 }, (_, i) => ({
  message: {
    _message_key: String(i),
    _origIdx: i,
    role: "assistant",
    text: "合成 Markdown 正文 **测试**。".repeat(100),
  },
}));
const context = { lang: "zh", query: "", regex: false };
const cache = new Map(
  planMessageUpdates(groups, new Map(), context).map((entry) => [
    entry.key,
    entry,
  ])
);
groups[799].message.text += "新增内容";
const start = performance.now();
const plan = planMessageUpdates(groups, cache, context);
console.log(
  JSON.stringify(
    {
      scenario: "synthetic-only",
      requests: {
        candidates: 100,
        beforeDispatches: 100,
        afterDispatches: dispatched,
      },
      refresh: { candidates: 100, beforeRounds: 100, afterRounds: rounds },
      messages: {
        total: groups.length,
        beforeRebuilds: groups.length,
        afterRebuilds: plan.filter((entry) => !entry.reuse).length,
        planningMs: +(performance.now() - start).toFixed(2),
      },
    },
    null,
    2
  )
);
