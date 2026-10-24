import { t } from "./i18n.js";

// 每批匹配拥有独立 Worker；取消或超时后立即终止，避免旧会话任务继续占用资源。
export function regexMatchRanges(
  texts,
  query,
  {
    signal,
    timeoutMs = 1000,
    createWorker = () =>
      new Worker(new URL("./search-highlight-worker.js", import.meta.url), {
        type: "module",
      }),
  } = {}
) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("请求已取消", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    const finish = (error, ranges) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(ranges);
    };
    const abort = () => finish(new DOMException("请求已取消", "AbortError"));
    const timer = setTimeout(
      () => finish(new Error(t("searchHighlightTimeout"))),
      timeoutMs
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.error) {
        finish(
          new Error(
            t(
              data.error === "limit"
                ? "searchHighlightLimit"
                : "searchHighlightFailed"
            )
          )
        );
      } else {
        finish(null, data.ranges);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(new Error(t("searchHighlightFailed")));
    };
    try {
      worker.postMessage({ texts, query });
    } catch (error) {
      finish(error);
    }
  });
}
