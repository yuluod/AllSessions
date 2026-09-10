const WIDTHS_KEY = "allsessions_pane_widths";
const COMPACT_LAYOUT_QUERY = "(max-width: 1040px)";
const KEYBOARD_STEP = 24;

const PANES = {
  rail: {
    varName: "--rail-w",
    paneSelector: "#source-rail",
    min: 180,
    max: 400,
    viewportShare: 0.3,
  },
  list: {
    varName: "--list-w",
    paneSelector: ".session-pane",
    min: 320,
    max: 760,
    viewportShare: 0.55,
  },
};

let compactQuery = null;
let storedWidths = {};

function paneElement(pane) {
  return document.querySelector(PANES[pane].paneSelector);
}

function clampWidth(pane, value) {
  const config = PANES[pane];
  const width = Number(value);
  if (!Number.isFinite(width)) return null;
  const viewportMax = Math.round(window.innerWidth * config.viewportShare);
  const max = Math.min(config.max, viewportMax);
  if (max <= config.min) return config.min;
  return Math.min(max, Math.max(config.min, Math.round(width)));
}

function readStoredWidths() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WIDTHS_KEY) || "{}");
    const widths = {};
    for (const pane of Object.keys(PANES)) {
      const width = clampWidth(pane, parsed[pane]);
      if (width) widths[pane] = width;
    }
    return widths;
  } catch {
    return {};
  }
}

function persistWidths() {
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(storedWidths));
  } catch {
    // 存储不可用时仍允许当前窗口调整栏宽。
  }
}

function applyPaneWidths() {
  const root = document?.documentElement;
  if (!root) return;
  const compact = compactQuery?.matches === true;
  for (const [pane, config] of Object.entries(PANES)) {
    const width = storedWidths[pane];
    if (compact || !width) {
      root.style.removeProperty(config.varName);
    } else {
      root.style.setProperty(config.varName, `${width}px`);
    }
  }
}

function setPaneWidth(pane, width) {
  const clamped = clampWidth(pane, width);
  if (!clamped) return;
  storedWidths[pane] = clamped;
  applyPaneWidths();
}

function resetPaneWidth(pane) {
  delete storedWidths[pane];
  applyPaneWidths();
  persistWidths();
}

function currentPaneWidth(pane) {
  const paneEl = paneElement(pane);
  return paneEl ? Math.round(paneEl.getBoundingClientRect().width) : null;
}

function beginResize(pane, event) {
  if (event.button !== 0) return;
  event.preventDefault();
  const handle = event.currentTarget;
  const paneEl = paneElement(pane);
  if (!paneEl || typeof handle.setPointerCapture !== "function") return;

  handle.setPointerCapture(event.pointerId);
  handle.classList.add("is-active");
  document.body.classList.add("is-resizing");

  const handleMove = (moveEvent) => {
    setPaneWidth(pane, moveEvent.clientX - paneEl.getBoundingClientRect().left);
  };
  const handleEnd = (endEvent) => {
    if (typeof handle.releasePointerCapture === "function") {
      try {
        handle.releasePointerCapture(endEvent.pointerId);
      } catch {
        // 指针已释放时无需处理。
      }
    }
    handle.removeEventListener("pointermove", handleMove);
    handle.removeEventListener("pointerup", handleEnd);
    handle.removeEventListener("pointercancel", handleEnd);
    handle.classList.remove("is-active");
    document.body.classList.remove("is-resizing");
    persistWidths();
  };

  handle.addEventListener("pointermove", handleMove);
  handle.addEventListener("pointerup", handleEnd);
  handle.addEventListener("pointercancel", handleEnd);
}

function handleKeydown(pane, event) {
  const step =
    event.key === "ArrowLeft"
      ? -KEYBOARD_STEP
      : event.key === "ArrowRight"
        ? KEYBOARD_STEP
        : 0;
  if (!step) return;
  event.preventDefault();
  const current = currentPaneWidth(pane);
  if (current == null) return;
  setPaneWidth(pane, current + step);
  persistWidths();
}

function bindPaneResizers() {
  document.querySelectorAll("[data-pane-resizer]").forEach((handle) => {
    const pane = handle.dataset.paneResizer;
    if (!PANES[pane]) return;
    handle.addEventListener("pointerdown", (event) => beginResize(pane, event));
    handle.addEventListener("dblclick", () => resetPaneWidth(pane));
    handle.addEventListener("keydown", (event) => handleKeydown(pane, event));
  });
}

export function initPaneLayout() {
  if (typeof window?.matchMedia === "function") {
    compactQuery = window.matchMedia(COMPACT_LAYOUT_QUERY);
    compactQuery.addEventListener("change", applyPaneWidths);
  }
  storedWidths = readStoredWidths();
  applyPaneWidths();
  bindPaneResizers();
}
