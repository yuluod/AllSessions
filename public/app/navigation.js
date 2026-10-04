// 视图导航与键盘操作:工作区切换、返回首页、列表键盘导航与手动刷新。
import { t } from "../i18n.js";
import {
  EDITABLE_SHORTCUT_SELECTOR,
  wrapSelectionIndex,
} from "../keyboard-nav.js";
import {
  MOBILE_LAYOUT_QUERY,
  detailRequestGate,
  elements,
  fetchJson,
  scrollToWorkspaceSection,
  showError,
  state,
} from "./shared.js";
import { resetFilterState, syncFilterControls, syncUrl } from "./filters.js";
import { setInspectorOpen, setPropsPlaceholder } from "./detail-view.js";
import {
  loadFacets,
  loadSessions,
  loadStats,
  loadWorkspaceDiagnostics,
} from "./data.js";
import { selectSession } from "./session-list.js";
import { renderWorkspaceStatus } from "./status.js";

export async function returnHome() {
  detailRequestGate.cancel();
  resetFilterState();
  state.selectedSessionKey = null;
  state.currentDetail = null;
  state.activeTab = "conversation";
  state.detailQuery = "";
  state.roleFilter = "";
  setPropsPlaceholder(t("selectSession"));
  setInspectorOpen(false);
  if (elements.sidebarFilters) elements.sidebarFilters.open = false;
  if (elements.projectNav) elements.projectNav.open = false;
  syncFilterControls();
  syncUrl();
  await activateWorkspaceView("list");
  await Promise.all([loadSessions(), loadStats()]);
  window.scrollTo({ top: 0, behavior: "auto" });
}

export async function activateWorkspaceView(panel) {
  state.activeView = panel;
  document.body.dataset.view = panel;
  if (elements.appLayout) elements.appLayout.dataset.view = panel;
  if (elements.sidebarLeft) elements.sidebarLeft.dataset.activePanel = panel;
  if (panel === "stats") {
    if (elements.projectNav) elements.projectNav.open = true;
    if (elements.sidebarFilters) elements.sidebarFilters.open = true;
  }

  document.querySelectorAll(".sidebar-tab").forEach((tab) => {
    const active = tab.dataset.sidebarTab === panel;
    tab.classList.toggle("active", active);
    if (active) {
      tab.setAttribute("aria-current", "page");
    } else {
      tab.removeAttribute("aria-current");
    }
  });
  document.querySelectorAll("[data-view-panel]").forEach((viewPanel) => {
    const active = viewPanel.dataset.viewPanel === panel;
    viewPanel.classList.toggle("hidden", !active);
    viewPanel.setAttribute("aria-hidden", active ? "false" : "true");
  });

  const codexRollbackDashboard = document.querySelector(
    "#codex-rollback-dashboard"
  );
  const isList = panel === "list";
  if (!isList) setInspectorOpen(false);
  codexRollbackDashboard?.classList.add("hidden");
  renderWorkspaceStatus();
}
export function isEditableShortcutTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(EDITABLE_SHORTCUT_SELECTOR));
}

export function sessionKeyboardItems() {
  return Array.from(elements.sessionList.querySelectorAll(".session-item"));
}

export function moveSessionSelection(direction) {
  const items = sessionKeyboardItems();
  if (!items.length) return;
  const focused = document.activeElement?.closest?.(".session-item");
  const selected = items.find((item) => item.classList.contains("active"));
  const current = focused || selected;
  const next =
    items[wrapSelectionIndex(items.indexOf(current), items.length, direction)];
  next.focus();
  next.scrollIntoView({ block: "nearest" });
  const sessionKey = next.dataset.sessionKey;
  if (sessionKey) selectSession(sessionKey, next);
}

let refreshing = false;
export async function refreshSessions() {
  if (refreshing) return;
  refreshing = true;
  if (elements.refreshBtn) {
    elements.refreshBtn.disabled = true;
    elements.refreshBtn.textContent = t("refreshing");
  }
  try {
    await fetchJson("/api/refresh");
    await Promise.all([loadFacets(), loadWorkspaceDiagnostics()]);
    await Promise.all([loadSessions({ background: true }), loadStats()]);
  } catch (error) {
    showError(`${t("refreshFailed")}: ${error.message}`);
  } finally {
    refreshing = false;
    if (elements.refreshBtn) {
      elements.refreshBtn.disabled = false;
      elements.refreshBtn.textContent = t("refresh");
    }
  }
}

export function closeTopDialogFromKeyboard() {
  const dialogs = Array.from(document.querySelectorAll("dialog[open]"));
  const dialog = dialogs.at(-1);
  if (!dialog) return false;
  const cancelEvent = new Event("cancel", { cancelable: true });
  if (dialog.dispatchEvent(cancelEvent)) dialog.close();
  return true;
}

export function openFocusedSession() {
  const item = document.activeElement?.closest?.(".session-item");
  const sessionKey = item?.dataset.sessionKey;
  if (!item || !sessionKey) return false;
  selectSession(sessionKey, item);
  if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
    scrollToWorkspaceSection(document.querySelector("#detail-panel"));
  }
  return true;
}
