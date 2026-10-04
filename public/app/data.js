// 数据加载:会话列表/详情/统计/ facets/诊断与索引进度轮询。
import { t } from "../i18n.js";
import { isAbortError, nextPaint } from "../async-coordinator.js";
import { createIndexProgressPoller } from "../index-progress.js";
import { renderStats } from "../stats-view.js";
import {
  MOBILE_LAYOUT_QUERY,
  detailRequestGate,
  elements,
  fetchJson,
  scrollToWorkspaceSection,
  sessionRequestGate,
  showError,
  state,
  statsRequestGate,
  visibleSessions,
} from "./shared.js";
import {
  buildSearchUrl,
  buildSessionQuery,
  buildSessionsUrl,
  syncFilterControls,
  syncSessionRoot,
  syncUrl,
  updateFacetFilters,
} from "./filters.js";
import {
  appendLoadedSessions,
  renderSessionList,
  updateSessionCount,
} from "./session-list.js";
import { conversationView, maintenanceController } from "./controllers.js";
import {
  renderDetailTags,
  renderPropsPanel,
  renderRawEvents,
  setDetailPlaceholder,
  setPropsPlaceholder,
  showSelectSessionPlaceholder,
  syncRoleFilterButtons,
  syncSessionArchiveButton,
  syncSessionDeleteButton,
  syncSessionWorkspaceControls,
  updateTabs,
} from "./detail-view.js";
import { renderWorkspaceStatus } from "./status.js";

export async function loadSessionDetail(id, { silent = false } = {}) {
  const request = detailRequestGate.begin();
  try {
    const around =
      state.searchQuery && state.selectedSearchHit?.sessionKey === id
        ? state.selectedSearchHit.ordinal
        : null;
    const suffix = Number.isInteger(around)
      ? `?${new URLSearchParams({ around: String(around), message: state.selectedSearchHit.message_key || "", term: state.selectedSearchHit.term || "" })}`
      : "";
    const detail = await fetchJson(
      `/api/sessions/${encodeURIComponent(id)}${suffix}`,
      {
        signal: request.signal,
      }
    );
    if (!request.isCurrent() || state.selectedSessionKey !== id) return false;
    // 本地 IPC 常在一帧内返回，先让列表高亮与加载占位绘制出来，再做重渲染。
    await nextPaint();
    if (!request.isCurrent() || state.selectedSessionKey !== id) return false;
    state.currentDetail = detail;
    state.roleFilter = "";
    state.detailQuery = state.searchQuery;
    if (elements.detailSearchInput) {
      elements.detailSearchInput.value = state.detailQuery;
    }
    if (elements.showToolsToggle) {
      elements.showToolsToggle.checked = state.showTools;
    }
    if (elements.showContextToggle) {
      elements.showContextToggle.checked = state.showContext;
    }
    if (elements.conversationDescToggle) {
      elements.conversationDescToggle.checked = state.conversationDesc;
    }
    syncRoleFilterButtons();
    elements.detailEmpty.classList.add("hidden");
    elements.detailView.classList.remove("hidden");
    const fullCwd = detail.summary.cwd || t("noWorkDir");
    elements.detailTitle.textContent =
      detail.summary.title || fullCwd.split(/[\\/]/).pop() || fullCwd;
    elements.detailTitle.title = fullCwd;
    renderDetailTags(detail.summary);
    syncSessionWorkspaceControls(detail.summary);
    syncSessionArchiveButton();
    syncSessionDeleteButton();
    renderPropsPanel(detail.summary, detail.conversation_messages);
    conversationView.renderConversation(detail.conversation_messages);
    document
      .querySelector("#search-full-session")
      ?.classList.toggle("hidden", !detail.search_context);
    for (const button of [elements.exportMdBtn, elements.exportJsonBtn]) {
      if (button) {
        button.disabled = Boolean(detail.search_context);
        button.title = detail.search_context ? t("searchContextExport") : "";
      }
    }
    if (detail.search_context) {
      const targetIndex = detail.conversation_messages.findIndex(
        (message) => message.search_ordinal === detail.search_target
      );
      const target = elements.conversationList.querySelector(
        `#message-${targetIndex + 1}`
      );
      if (target?.classList.contains("collapsed"))
        target.querySelector(".message-toggle")?.click();
      target?.scrollIntoView({ block: "center" });
    }
    renderRawEvents(detail.raw_events);
    updateTabs();
    if (state._initialized && window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
      scrollToWorkspaceSection(document.querySelector("#detail-panel"));
    }
    return true;
  } catch (error) {
    if (isAbortError(error) || !request.isCurrent()) return false;
    console.error(error);
    if (silent) return false;
    showError(`${t("loadDetailFailed")}: ${error.message}`);
    if (state.selectedSessionKey === id) {
      state.currentDetail = null;
      elements.detailView.classList.add("hidden");
      elements.detailEmpty.classList.remove("hidden");
      setDetailPlaceholder(t("loadDetailFailed"), error.message);
      setPropsPlaceholder(t("loadDetailFailed"));
    }
    return false;
  }
}
export async function loadSessions({
  reportError = true,
  background = false,
} = {}) {
  const request = sessionRequestGate.begin();
  detailRequestGate.cancel();
  state.lastSessionError = null;
  try {
    let data;
    if (state.searchQuery) {
      data = await fetchJson(buildSearchUrl(), { signal: request.signal });
      if (!request.isCurrent()) return false;
      state.sessions = data.sessions;
      state.hasMore = data.has_more;
      state.nextCursor = data.next_cursor;
    } else {
      data = await fetchJson(buildSessionsUrl(), { signal: request.signal });
      if (!request.isCurrent()) return false;
      state.sessions = data.sessions;
      state.hasMore = data.has_more;
      state.nextCursor = data.next_cursor;
    }
    if (data.session_roots) {
      state.facets = { ...state.facets, session_roots: data.session_roots };
    }
    state.scanning = data.scanning === true;
    document
      .querySelector("#search-sort")
      ?.classList.toggle("hidden", !state.searchQuery);
    document
      .querySelector("#list-sort-label")
      ?.classList.toggle("hidden", Boolean(state.searchQuery));
    const searchCount = document.querySelector("#search-result-count");
    if (searchCount)
      searchCount.textContent = state.searchQuery
        ? state.scanning
          ? t("searchIndexing")
          : t("searchSessionCount", { n: data.total || 0 })
        : "";
    syncSessionRoot();

    const selectedMissing = Boolean(
      state.selectedSessionKey &&
      !visibleSessions().find(
        (session) => session._key === state.selectedSessionKey
      )
    );
    // 初始化恢复与后台刷新都保留首屏之外的选择（详情接口可按 key 直读）；
    // 只有用户主动改变列表语义（筛选、搜索、设置迁移等）才在当前列表
    // 找不到目标时清除选择。
    if (state._initialized && !background && selectedMissing) {
      state.selectedSessionKey = null;
      state.currentDetail = null;
    }

    const keepingOffscreenSelection =
      selectedMissing && (background || !state._initialized);

    renderSessionList();

    if (!state._initialized && !state.selectedSessionKey && state.sessions[0]) {
      const first = visibleSessions()[0];
      if (first) state.selectedSessionKey = first._key;
    }

    if (state.selectedSessionKey) {
      elements.sessionList.querySelectorAll(".session-item").forEach((el) => {
        el.classList.toggle(
          "active",
          el.dataset.sessionKey === state.selectedSessionKey
        );
      });
      const restoreKey = state.selectedSessionKey;
      const loaded = await loadSessionDetail(restoreKey, {
        silent: keepingOffscreenSelection,
      });
      if (
        keepingOffscreenSelection &&
        !loaded &&
        request.isCurrent() &&
        // 加载期间用户手动选择了其他会话时不回退
        state.selectedSessionKey === restoreKey
      ) {
        if (!state._initialized) {
          // 初始化恢复的分享链接已失效：静默回退为默认选中第一个
          state.selectedSessionKey = null;
          const first = visibleSessions()[0];
          if (first) {
            state.selectedSessionKey = first._key;
            elements.sessionList
              .querySelectorAll(".session-item")
              .forEach((el) => {
                el.classList.toggle(
                  "active",
                  el.dataset.sessionKey === first._key
                );
              });
            await loadSessionDetail(first._key);
          }
        } else {
          // 后台刷新时目标会话已被删除：清除选择并显示占位
          state.selectedSessionKey = null;
          state.currentDetail = null;
          showSelectSessionPlaceholder();
        }
      }
    } else {
      showSelectSessionPlaceholder();
    }
    if (request.isCurrent() && state._initialized) syncUrl();
    return request.isCurrent();
  } catch (error) {
    if (isAbortError(error) || !request.isCurrent()) return false;
    console.error(error);
    state.lastSessionError = error;
    if (reportError) {
      showError(`${t("loadListFailed")}: ${error.message}`);
    }
    return false;
  }
}

export async function loadMoreSessions() {
  const request = sessionRequestGate.begin();
  try {
    const url = state.searchQuery
      ? buildSearchUrl({ cursor: state.nextCursor })
      : buildSessionsUrl({ cursor: state.nextCursor });
    const data = await fetchJson(url, {
      signal: request.signal,
    });
    if (!request.isCurrent()) return false;
    const added = data.sessions;
    state.sessions = state.sessions.concat(added);
    state.hasMore = data.has_more;
    state.nextCursor = data.next_cursor;
    appendLoadedSessions(added);
    return true;
  } catch (error) {
    if (isAbortError(error) || !request.isCurrent()) return false;
    console.error(error);
    showError(`${t("loadMoreFailed")}: ${error.message}`);
    return false;
  }
}

export async function loadStats() {
  const request = statsRequestGate.begin();
  try {
    const params = buildSessionQuery();
    const url = `/api/stats${params ? "?" + params : ""}`;
    const stats = await fetchJson(url, { signal: request.signal });
    if (!request.isCurrent()) return false;
    state.stats = stats;
    renderStats(stats, elements);
    updateSessionCount();
    return true;
  } catch (error) {
    if (isAbortError(error) || !request.isCurrent()) return false;
    console.error(error);
    showError(`${t("loadStatsFailed")}: ${error.message}`);
    return false;
  }
}

export async function loadFacets() {
  state.facets = await fetchJson("/api/facets");
  syncSessionRoot();
  updateFacetFilters();
  syncFilterControls();
}

export async function loadWorkspaceDiagnostics() {
  const payload = await fetchJson("/api/settings");
  state.diagnostics = payload?.diagnostics || null;
  renderWorkspaceStatus();
}

export const indexProgressPoller = createIndexProgressPoller({
  read: () => fetchJson("/api/index-status"),
  isVisible: () => !document.hidden,
  render: (status) => {
    state.indexProgress = status;
    renderWorkspaceStatus();
  },
  onError: (error) => {
    console.warn("读取索引进度失败", error);
    state.indexProgress = { phase: "unavailable" };
    renderWorkspaceStatus();
  },
});
document.addEventListener("visibilitychange", () => {
  if (state._initialized) void indexProgressPoller.refresh();
});

export async function loadCapabilities() {
  try {
    state.capabilities = await fetchJson("/api/capabilities");
  } catch (error) {
    console.error(error);
    state.capabilities = { codex_maintenance: { enabled: false } };
  }
  maintenanceController.setCapabilities(state.capabilities);
}
