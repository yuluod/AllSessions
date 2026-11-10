import { t } from "./i18n.js";

const WIDTHS_KEY = "allsessions_pane_widths";
// 沿用早期版本的存储键，升级后保留用户已有的收起偏好。
const RAIL_COLLAPSED_KEY = "allsessions_source_rail_collapsed";
const COMPACT_LAYOUT_QUERY = "(max-width: 1040px)";
// 手机布局下来源栏变成整幅顶栏，收起没有意义，直接停用。
const RAIL_COLLAPSE_DISABLED_QUERY = "(max-width: 760px)";
const KEYBOARD_STEP = 24;

const PANES = {
  rail: {
    varName: "--rail-w",
    paneSelector: "#source-rail",
    min: 180,
    max: 400,
  },
  list: {
    varName: "--list-w",
    paneSelector: ".session-pane",
    min: 320,
    max: 760,
  },
};

let compactQuery = null;
let railCollapseQuery = null;
let railCollapsed = false;
let storedWidths = {};

function paneElement(pane) {
  return document.querySelector(PANES[pane].paneSelector);
}

function clampWidth(pane, value) {
  const config = PANES[pane];
  const width = Number(value);
  if (!Number.isFinite(width)) return null;
  return Math.min(config.max, Math.max(config.min, Math.round(width)));
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

// 宽度偏好保留原值，窗口变窄时只约束实际宽度，重新放大即可恢复。
export function fitPaneWidths({ rail, list, budget, railCollapsed = false }) {
  const railMin = railCollapsed ? rail : PANES.rail.min;
  const listMin = PANES.list.min;
  const excess = Math.max(0, rail + list - budget);
  const flexible = rail - railMin + list - listMin;
  const ratio = flexible > 0 ? Math.min(1, excess / flexible) : 0;
  return {
    rail: Math.floor(rail - (rail - railMin) * ratio),
    list: Math.floor(list - (list - listMin) * ratio),
  };
}

export function syncPaneLayout() {
  const root = document?.documentElement;
  if (!root) return;
  const compact = compactQuery?.matches === true;
  for (const config of Object.values(PANES))
    root.style.removeProperty(config.varName);
  if (compact) return;
  const collapsed = railShell()?.classList.contains("rail-collapsed") === true;
  const inspectorOpen = !document
    .querySelector(".app-layout")
    ?.classList.contains("inspector-collapsed");
  const css =
    typeof getComputedStyle === "function" ? getComputedStyle(root) : null;
  const pixels = (name, fallback) =>
    parseFloat(css?.getPropertyValue(name)) || fallback;
  const viewport = window.innerWidth || 1920;
  const inspector =
    viewport > 1640 && inspectorOpen ? pixels("--inspector-w", 280) : 0;
  const widths = fitPaneWidths({
    rail: collapsed
      ? pixels("--rail-collapsed-w", 56)
      : storedWidths.rail || currentPaneWidth("rail") || 260,
    list:
      storedWidths.list ||
      currentPaneWidth("list") ||
      Math.min(500, Math.max(400, viewport * 0.32)),
    budget: viewport - inspector - pixels("--reading-min-width", 480) - 40,
    railCollapsed: collapsed,
  });
  for (const [pane, config] of Object.entries(PANES)) {
    if (pane === "rail" && collapsed) continue;
    root.style.setProperty(config.varName, `${widths[pane]}px`);
  }
  document.querySelectorAll("[data-pane-resizer]").forEach((handle) => {
    const pane = handle.dataset.paneResizer;
    if (!PANES[pane]) return;
    handle.setAttribute("aria-valuemin", String(PANES[pane].min));
    handle.setAttribute("aria-valuemax", String(PANES[pane].max));
    handle.setAttribute("aria-valuenow", String(widths[pane]));
  });
}

function setPaneWidth(pane, width) {
  const clamped = clampWidth(pane, width);
  if (!clamped) return;
  storedWidths[pane] = clamped;
  syncPaneLayout();
}

function resetPaneWidth(pane) {
  delete storedWidths[pane];
  syncPaneLayout();
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

function railShell() {
  return document?.querySelector(".page-shell") || null;
}

// 收起态挂在 .page-shell 上：侧栏宽度与它的分隔条要一起切换。
export function syncRailToggle() {
  const shell = railShell();
  const toggle = document?.querySelector("#rail-toggle");
  if (!shell || !toggle) return;
  const expanded = !shell.classList.contains("rail-collapsed");
  const label = t(expanded ? "hideSourceRail" : "showSourceRail");
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
}

export function setRailCollapsed(collapsed, { persist = true } = {}) {
  railCollapsed = collapsed;
  applyRailCollapse();
  if (!persist) return;
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, String(collapsed));
  } catch {
    // 存储不可用时仍保留当前窗口的收起状态。
  }
}

function applyRailCollapse() {
  const shell = railShell();
  if (!shell) return;
  shell.classList.toggle(
    "rail-collapsed",
    railCollapsed && railCollapseQuery?.matches !== true
  );
  syncRailToggle();
  syncPaneLayout();
}

function readRailCollapsed() {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function bindRailToggle() {
  document?.querySelector("#rail-toggle")?.addEventListener("click", () => {
    setRailCollapsed(!railShell()?.classList.contains("rail-collapsed"));
  });
}

export function initPaneLayout() {
  if (typeof window?.matchMedia === "function") {
    compactQuery = window.matchMedia(COMPACT_LAYOUT_QUERY);
    compactQuery.addEventListener("change", syncPaneLayout);
    railCollapseQuery = window.matchMedia(RAIL_COLLAPSE_DISABLED_QUERY);
    railCollapseQuery.addEventListener("change", applyRailCollapse);
  }
  storedWidths = readStoredWidths();
  syncPaneLayout();
  bindPaneResizers();
  setRailCollapsed(readRailCollapsed(), { persist: false });
  bindRailToggle();
  window.addEventListener?.("resize", syncPaneLayout);
}
