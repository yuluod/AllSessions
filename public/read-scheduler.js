import { recordMetric } from "./performance-metrics.js";

// 有取消信号的交互只读请求按通道串行；写操作及批量导出不进入此队列。
export function createReadScheduler() {
  const lanes = new Map();
  return function schedule(lane, run, signal) {
    if (!lane || !signal) return run();
    return new Promise((resolve, reject) => {
      let state = lanes.get(lane);
      if (!state) {
        state = { running: false, pending: null };
        lanes.set(lane, state);
      }
      const entry = { run, resolve, reject, signal, abort: null };
      const abort = () => {
        if (state.pending !== entry) return;
        state.pending = null;
        signal.removeEventListener("abort", abort);
        recordMetric("read.skipped");
        reject(new DOMException("请求已取消", "AbortError"));
      };
      entry.abort = abort;
      if (state.pending) {
        const old = state.pending;
        old.signal.removeEventListener("abort", old.abort);
        old.reject(new DOMException("请求已替代", "AbortError"));
        recordMetric("read.skipped");
      }
      state.pending = entry;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const pump = async () => {
        if (state.running) return;
        state.running = true;
        while (state.pending) {
          const next = state.pending;
          state.pending = null;
          next.signal.removeEventListener("abort", next.abort);
          try {
            next.resolve(await next.run());
          } catch (error) {
            next.reject(error);
          }
        }
        state.running = false;
        lanes.delete(lane);
      };
      void pump();
    });
  };
}

export function readLane(url, method = "GET") {
  if (method !== "GET") return null;
  const path = url.split("?")[0];
  if (path === "/api/search" || path === "/api/sessions") return "sessions";
  if (
    path === "/api/stats" ||
    path === "/api/stats/sessions" ||
    path === "/api/facets"
  )
    return path;
  if (path.startsWith("/api/sessions/")) return "detail";
  return null;
}
