// 视图导航与键盘操作:工作区切换、返回首页、列表键盘导航与手动刷新。
import { t } from "../i18n.js";
import { closeFocusedDialog } from "../ui-components.js";
import {
  EDITABLE_SHORTCUT_SELECTOR,
  wrapSelectionIndex,
} from "../keyboard-nav.js";
import {
  MOBILE_LAYOUT_QUERY,
  announce,
  detailRequestGate,
  elements,
  fetchJson,
  scrollToWorkspaceSection,
  showError,
  state,
  visibleSessions,
} from "./shared.js";
import {
  renderActiveFilters,
  resetFilterState,
  syncFilterControls,
  syncUrl,
} from "./filters.js";
import { closeInspectorDrawer, setPropsPlaceholder } from "./detail-view.js";
import {
  loadFacets,
  loadSessions,
  loadStats,
  renderCurrentStats,
  loadStatsSessions,
  loadWorkspaceDiagnostics,
  refreshWorkspace,
} from "./data.js";
import { selectSession } from "./session-list.js";
import { renderWorkspaceStatus } from "./status.js";
import { handoffController } from "./controllers.js";

export async function returnHome() {
  // 返回首页会卸载当前详情，同样先过交接草稿检查。
  if (
    handoffController &&
    !(await handoffController.confirmLeave({ key: null }))
  ) {
    return;
  }
  detailRequestGate.cancel();
  resetFilterState();
  state.selectedSessionKey = null;
  state.currentDetail = null;
  state.activeTab = "conversation";
  state.detailQuery = "";
  state.roleFilter = "";
  setPropsPlaceholder(t("selectSession"));
  closeInspectorDrawer();
  syncFilterControls();
  syncUrl();
  await activateWorkspaceView("list");
  await refreshWorkspace(["query", "stats"]);
  window.scrollTo({ top: 0, behavior: "auto" });
}

export async function openActivitySearch(kind, value) {
  state.searchQuery = "";
  state.searchRole = "";
  state.searchTool = "";
  state.searchExactTool = kind === "tool" ? value : "";
  state.searchCommand = kind === "command" ? value : "";
  state.searchRegex = false;
  state.searchFrom = "";
  state.searchTo = "";
  state.selectedSearchHit = null;
  syncFilterControls();
  syncUrl();
  await activateWorkspaceView("list");
  await loadSessions();
}

export async function openReviewSession(key) {
  state.searchQuery = "";
  state.searchExactTool = "";
  state.searchCommand = "";
  state.selectedSearchHit = null;
  state.selectedSessionKey = null;
  syncFilterControls();
  await activateWorkspaceView("list");
  if (!(await loadSessions())) return;
  selectSession(key);
}

export async function activateWorkspaceView(panel) {
  state.activeView = panel;
  // 复用同一组筛选控件，统计页也明确展示当前条件，避免隐藏筛选影响结果。
  const filterControls = document.querySelector("#session-query-controls");
  const filterSlot = document.querySelector(
    panel === "stats" ? "#stats-filter-slot" : "#session-filter-slot"
  );
  if (filterControls && filterSlot) filterSlot.append(filterControls);
  const visibilityMenu = document.querySelector("#list-filter-menu");
  if (visibilityMenu) visibilityMenu.open = false;
  document.body.dataset.view = panel;
  if (elements.appLayout) elements.appLayout.dataset.view = panel;
  if (elements.sidebarLeft) elements.sidebarLeft.dataset.activePanel = panel;

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
  if (!isList) closeInspectorDrawer();
  codexRollbackDashboard?.classList.add("hidden");
  renderActiveFilters();
  renderWorkspaceStatus();
  if (isList && state.sessionsDirty) await loadSessions({ background: true });
  if (panel === "stats") {
    if (state.statsDirty || !state.stats) void loadStats();
    else {
      renderCurrentStats();
      if (!state.statsSessions && !state.statsSessionsLoading)
        void loadStatsSessions();
    }
  }
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
  if (sessionKey) selectSession(sessionKey, next, null, { deferDetail: true });
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
  return closeFocusedDialog();
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

// 托盘「最近会话」入口：目标会话按默认可见口径取数，当前筛选可能把它挡在
// 列表外，此时先回到默认列表再选中，避免“打开了却不在列表中”。
export async function openSessionFromTray(key) {
  if (!key) return;
  if (state.activeView !== "list") {
    await activateWorkspaceView("list");
  }
  if (!visibleSessions().some((session) => session._key === key)) {
    resetFilterState();
    syncFilterControls();
    await loadSessions();
  }
  const button = elements.sessionList.querySelector(
    `.session-item[data-session-key="${CSS.escape(key)}"]`
  );
  selectSession(key, button || undefined);
  button?.scrollIntoView({ block: "nearest" });
}

// 托盘「恢复会话」：恢复直接走 sessionKey 后端路由，不等详情加载完；
// 同时照常选中并展示会话，终端启动行为与错误提示同界面内按钮一致。
export async function resumeSessionFromTray(key) {
  if (!key) return;
  void openSessionFromTray(key).catch((error) => {
    console.error(error);
    showError(error.message);
  });
  try {
    const result = await fetchJson("/api/sessions/resume", {
      method: "POST",
      body: { sessionKey: key },
    });
    announce(t("resumeLaunched", { command: result.command || "" }));
  } catch (error) {
    showError(`${t("resumeFailed")}: ${error.message || error}`);
  }
}

export async function bindTauriTrayEvents() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  await listen("open-session", (event) => {
    void openSessionFromTray(event.payload?.key).catch((error) => {
      console.error(error);
      showError(error.message);
    });
  });
  await listen("resume-session", (event) => {
    void resumeSessionFromTray(event.payload?.key).catch((error) => {
      console.error(error);
      showError(error.message);
    });
  });
}
