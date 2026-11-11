// 键盘导航的纯逻辑：不触碰 DOM，只根据按键与上下文给出应执行的动作，
// 由 app.js 负责把动作落到界面上。

export const EDITABLE_SHORTCUT_SELECTOR =
  "input, textarea, select, [contenteditable='true']";

export const VIEW_SHORTCUTS = { 1: "list", 2: "stats", 3: "tools" };

/** 侧边栏 Tab 的方向键导航；不相关按键返回 null。 */
export function resolveTabIndex(key, currentIndex, length) {
  if (length <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (currentIndex + 1) % length;
    case "ArrowLeft":
      return (currentIndex - 1 + length) % length;
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return null;
  }
}

/** 会话列表循环移动：index 为 -1 时向下从头开始、向上从尾开始。 */
export function wrapSelectionIndex(index, length, direction) {
  if (length <= 0) return -1;
  if (direction > 0) return index < length - 1 ? index + 1 : 0;
  return index > 0 ? index - 1 : length - 1;
}

/**
 * 解析全局快捷键。
 * @param {{key: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean}} event
 * @param {{editableTarget: boolean, dialogOpen: boolean, inspectorOpen: boolean, arrowFromList: boolean}} context
 * @returns {{type: string, view?: string, direction?: number} | null}
 */
export function resolveGlobalShortcut(event, context) {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.altKey || event.getModifierState?.("AltGraph")) return null;
  const { key } = event;
  if (key === "Escape") {
    if (context.dialogOpen) return { type: "close-dialog" };
    if (context.inspectorOpen) return { type: "close-inspector" };
    return null;
  }
  if (event.metaKey || event.ctrlKey) {
    if (context.dialogOpen) {
      // 与下方 ⌘, 一致地排除 Shift。
      return key === "," && !event.shiftKey && context.settingsDialogActive
        ? { type: "toggle-settings" }
        : null;
    }
    const lower = key.toLowerCase();
    if (lower === "k" || lower === "f") return { type: "focus-search" };
    // ⌘, 排除 Shift：Shift 组合留给系统与输入法，避免边缘组合误开设置。
    if (key === "," && !event.shiftKey) return { type: "toggle-settings" };
    if (lower === "r") return { type: "refresh" };
    if (VIEW_SHORTCUTS[key]) {
      return { type: "switch-view", view: VIEW_SHORTCUTS[key] };
    }
    if (!context.editableTarget && lower === "i") {
      return { type: "toggle-inspector" };
    }
    return null;
  }
  if (context.editableTarget || context.dialogOpen) return null;

  const view = VIEW_SHORTCUTS[key];
  // altKey 已在入口排除，此处不再重复检查。
  if (view && !event.metaKey && !event.ctrlKey) {
    return { type: "switch-view", view };
  }

  // Space 排除 Shift：Shift+Space 无勾选语义，避免批量模式下的边缘误触。
  if (
    key === " " &&
    !event.shiftKey &&
    context.bulkSelection &&
    context.focusedSession
  )
    return { type: "toggle-selection" };
  if (key.toLowerCase() === "n")
    return { type: "move-message", direction: event.shiftKey ? -1 : 1 };
  const moveDown = key === "j" || key === "ArrowDown";
  const moveUp = key === "k" || key === "ArrowUp";
  if (
    (moveDown || moveUp) &&
    (!key.startsWith("Arrow") || context.arrowFromList)
  ) {
    return { type: "move-selection", direction: moveDown ? 1 : -1 };
  }
  if (key === "Enter") return { type: "open-focused" };
  if (key === "/") return { type: "focus-detail-search" };
  if (key === "?") return { type: "shortcuts-help" };
  const bare = key.toLowerCase();
  if (bare === "f") return { type: "toggle-favorite" };
  if (bare === "a") return { type: "toggle-archive" };
  if (bare === "r") return { type: "resume-session" };
  if (bare === "l") return { type: "load-more" };
  return null;
}
