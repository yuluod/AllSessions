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
  const { key } = event;
  if (key === "Escape") {
    if (context.dialogOpen) return { type: "close-dialog" };
    if (context.inspectorOpen) return { type: "close-inspector" };
    return null;
  }
  if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === "k") {
    return { type: "focus-search" };
  }
  if (context.editableTarget || context.dialogOpen) return null;

  const view = VIEW_SHORTCUTS[key];
  if (view && !event.metaKey && !event.ctrlKey && !event.altKey) {
    return { type: "switch-view", view };
  }

  const moveDown = key === "j" || key === "ArrowDown";
  const moveUp = key === "k" || key === "ArrowUp";
  if (
    (moveDown || moveUp) &&
    (!key.startsWith("Arrow") || context.arrowFromList)
  ) {
    return { type: "move-selection", direction: moveDown ? 1 : -1 };
  }
  if (key === "Enter") return { type: "open-focused" };
  return null;
}
