import { createReadScheduler, readLane } from "./read-scheduler.js";
import { recordMetric } from "./performance-metrics.js";
const scheduleRead = createReadScheduler();
let requestSequence = 0;
const requestPrefix = globalThis.crypto?.randomUUID?.() || String(Date.now());

function abortError() {
  return new DOMException("请求已取消", "AbortError");
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return "";
  }
}

// 后端以 { code, message } 结构返回错误；code 用于 i18n，message 作为回退。
function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : null;
}

export const DESKTOP_RUNTIME_REQUIRED = "desktop_runtime_required";

export async function fetchJson(
  url,
  options = {},
  { formatError, translateCode } = {}
) {
  return scheduleRead(
    readLane(url, options.method || "GET"),
    () => invokeJson(url, options, { formatError, translateCode }),
    options.signal
  );
}

async function invokeJson(url, options, { formatError, translateCode }) {
  if (options.signal?.aborted) throw abortError();
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") {
    const error = new Error("当前页面不在 AllSessions 桌面应用中运行");
    error.code = DESKTOP_RUNTIME_REQUIRED;
    throw error;
  }
  let body = null;
  if (typeof options.body === "string" && options.body) {
    try {
      body = JSON.parse(options.body);
    } catch {
      throw new Error("请求内容不是有效的 JSON");
    }
  } else if (options.body && typeof options.body === "object") {
    body = options.body;
  }
  let result;
  const requestId =
    options.signal && readLane(url, options.method || "GET")
      ? `${requestPrefix}:${++requestSequence}`
      : undefined;
  const cancel = () => {
    if (requestId)
      void invoke("cancel_read_request", { requestId }).catch(() => {});
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  const started = performance.now();
  recordMetric("ipc.started");
  try {
    result = await invoke("request_json", {
      request: {
        url,
        method: options.method || "GET",
        body,
        ...(requestId ? { requestId } : {}),
      },
    });
  } catch (error) {
    if (options.signal?.aborted || error?.code === "request_cancelled")
      throw abortError();
    const code = errorCode(error);
    const raw = errorMessage(error);
    const translated = code && translateCode ? translateCode(code, raw) : null;
    // 兜底文案保持硬编码：本模块需在 Node 测试环境可直接导入，
    // 不能引入依赖 DOM 的 i18n.js；正常路径由 formatError/translateCode 提供本地化文案。
    const message =
      translated || raw || (formatError ? formatError(500) : "请求失败");
    const wrapped = new Error(message, { cause: error });
    if (code) wrapped.code = code;
    wrapped.backendMessage = raw;
    throw wrapped;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    recordMetric("ipc.duration_ms", performance.now() - started);
  }
  if (options.signal?.aborted) throw abortError();
  return result;
}
