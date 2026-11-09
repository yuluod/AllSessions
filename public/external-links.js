const EXTERNAL_LINK = /^(?:https?:|mailto:)/i;

export function isExternalHref(href) {
  return EXTERNAL_LINK.test(String(href || "").trim());
}

// Tauri webview 会静默丢弃 target="_blank" 导航，外链必须交给系统打开；
// 其余链接若放行默认行为会让主窗口离开应用页面。
export function bindExternalLinks(container, { open, onError } = {}) {
  if (!container || typeof open !== "function") return;
  container.addEventListener("click", (event) => {
    if (!window.__TAURI__?.core?.invoke) return;
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor || !container.contains(anchor)) return;
    event.preventDefault();
    const href = anchor.getAttribute("href");
    if (!isExternalHref(href)) return;
    Promise.resolve()
      .then(() => open(href.trim()))
      .catch((error) =>
        onError?.(error instanceof Error ? error.message : String(error))
      );
  });
}
