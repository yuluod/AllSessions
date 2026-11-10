// 提示队列只展示两条；重要提示等待空位，普通提示合并为最近一条。
export function createToastController({
  document,
  dismissLabel,
  createDismissIcon,
  schedule = setTimeout,
  cancel = clearTimeout,
  now = () => Date.now(),
}) {
  const pending = [];
  const visible = [];
  let stack;

  function pump() {
    while (visible.length < 2 && pending.length) mount(pending.shift());
  }

  function mount(entry) {
    const toast = document.createElement("div");
    toast.className = "app-toast";
    const text = document.createElement("span");
    text.className = "app-toast-text";
    text.textContent = entry.message;
    toast.append(text);
    let remaining = entry.duration ?? (entry.onAction ? 12000 : 4500);
    let timer;
    let started;
    let hovering = false;
    let dismissed = false;
    const pause = () => {
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
        remaining = Math.max(0, remaining - (now() - started));
      }
    };
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      pause();
      const restoreFocus = toast.contains(document.activeElement);
      toast.remove();
      visible.splice(visible.indexOf(entry), 1);
      pump();
      if (restoreFocus) {
        const origin = entry.origin;
        const target =
          origin !== document.body &&
          origin?.isConnected &&
          !origin.disabled &&
          origin.getClientRects().length
            ? origin
            : document.querySelector(".session-item.active, #search-input");
        target?.focus({ preventScroll: true });
      }
    };
    const resume = () => {
      pause();
      if (
        dismissed ||
        entry.sticky ||
        hovering ||
        toast.contains(document.activeElement)
      )
        return;
      started = now();
      timer = schedule(dismiss, remaining);
    };
    entry.dismiss = dismiss;
    if (entry.onAction) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "app-toast-action";
      action.textContent = entry.actionLabel;
      action.addEventListener("click", () => {
        dismiss();
        entry.onAction();
      });
      toast.append(action);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "app-banner-dismiss";
    close.setAttribute("aria-label", dismissLabel());
    close.append(createDismissIcon());
    close.addEventListener("click", dismiss);
    toast.append(close);
    toast.addEventListener("pointerenter", () => {
      hovering = true;
      pause();
    });
    toast.addEventListener("pointerleave", () => {
      hovering = false;
      resume();
    });
    toast.addEventListener("focusin", pause);
    toast.addEventListener("focusout", () => queueMicrotask(resume));
    visible.push(entry);
    stack.append(toast);
    resume();
  }

  return function show(message, options = {}) {
    if (!stack) {
      stack = document.createElement("div");
      stack.id = "toast-stack";
      stack.className = "toast-stack";
      document.querySelector(".page-shell").append(stack);
    }
    const entry = { ...options, message, origin: document.activeElement };
    if (!entry.actionLabel || typeof entry.onAction !== "function")
      delete entry.onAction;
    if (!entry.sticky && !entry.onAction) {
      const previous = pending.findIndex(
        (item) => !item.sticky && !item.onAction
      );
      if (previous >= 0) pending.splice(previous, 1);
    }
    pending.push(entry);
    if (visible.length >= 2) {
      const disposable = visible.find((item) => !item.sticky && !item.onAction);
      // 焦点或鼠标停留时也不提前移除普通提示。
      if (
        disposable &&
        !stack.contains(document.activeElement) &&
        !stack.matches(":hover")
      )
        disposable.dismiss();
    }
    pump();
  };
}
