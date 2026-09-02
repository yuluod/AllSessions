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
  try {
    result = await invoke("request_json", {
      request: {
        url,
        method: options.method || "GET",
        body,
      },
    });
  } catch (error) {
    const code = errorCode(error);
    const raw = errorMessage(error);
    const translated = code && translateCode ? translateCode(code, raw) : null;
    const message =
      translated || raw || (formatError ? formatError(500) : "请求失败");
    const wrapped = new Error(message, { cause: error });
    if (code) wrapped.code = code;
    wrapped.backendMessage = raw;
    throw wrapped;
  }
  if (options.signal?.aborted) throw abortError();
  return result;
}
