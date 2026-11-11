// 数据加载:会话列表/详情/统计/ facets/诊断与索引进度轮询。
import { t } from "../i18n.js";
import {
  isAbortError,
  nextPaint,
  createRefreshCoordinator,
  createLatestRequestGate,
} from "../async-coordinator.js";
import { applySessionPage, invalidateQuery } from "../workspace-state.js";
import { recordMetric } from "../performance-metrics.js";
import { createIndexProgressPoller } from "../index-progress.js";
import { renderStats } from "../stats-view.js";
import { renderStatsSessionList } from "../stats-session-list.js";
import {
  MOBILE_LAYOUT_QUERY,
  detailRequestGate,
  elements,
  fetchJson,
  isSearchActive,
  hasSearchOptions,
  scrollToWorkspaceSection,
  sessionRequestGate,
  showError,
  state,
  statsRequestGate,
  statsSessionsRequestGate,
  visibleSessions,
} from "./shared.js";
import {
  buildFacetsQuery,
  buildSearchUrl,
  buildSessionQuery,
  buildSessionsUrl,
  syncFilterControls,
  syncSessionRoot,
  syncUrl,
  setActivityRange,
  updateFacetFilters,
} from "./filters.js";
import { sessionNeedsLiveReload } from "../session-format.js";
import {
  appendLoadedSessions,
  renderSessionList,
  updateSessionCount,
  renderSessionListFooter,
} from "./session-list.js";
import { conversationView, maintenanceController } from "./controllers.js";
import {
  renderDetailTags,
  renderPropsPanel,
  renderRawEvents,
  setDetailPlaceholder,
  setPropsPlaceholder,
  showSelectSessionPlaceholder,
  syncDetailTitle,
  syncRoleFilterButtons,
  syncSessionArchiveButton,
  syncSessionDeleteButton,
  syncSessionWorkspaceControls,
  updateTabs,
} from "./detail-view.js";
import { renderWorkspaceStatus } from "./status.js";
import { openActivitySearch, openReviewSession } from "./navigation.js";

export async function loadSessionDetail(
  id,
  { silent = false, initial = false, live = false } = {}
) {
  const request = detailRequestGate.begin();
  try {
    const around =
      isSearchActive() && state.selectedSearchHit?.sessionKey === id
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
    // 请求期间用户仍可能滚动；仅在替换内容前记录最新阅读位置。
    const scroller = live
      ? elements.conversationList?.closest(".detail-shell")
      : null;
    const liveScroll = scroller
      ? {
          top: scroller.scrollTop,
          atBottom:
            !state.conversationDesc &&
            scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
              80,
        }
      : null;
    state.currentDetail = detail;
    if (!live) {
      state.roleFilter = "";
      state.detailQuery = state.searchQuery;
    }
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
    syncDetailTitle(detail.summary);
    renderDetailTags(detail.summary);
    syncSessionWorkspaceControls(detail.summary);
    syncSessionArchiveButton();
    syncSessionDeleteButton();
    renderPropsPanel(detail.summary);
    await conversationView.renderConversation(detail.conversation_messages);
    if (!request.isCurrent() || state.selectedSessionKey !== id) return false;
    document
      .querySelector("#search-full-session")
      ?.classList.toggle("hidden", !detail.search_context);
    for (const button of [elements.exportMdBtn, elements.exportJsonBtn]) {
      if (button) {
        button.disabled = Boolean(detail.search_context);
        button.title = detail.search_context
          ? t("searchContextExport")
          : t("exportScopeHint");
      }
    }
    if (detail.search_context) {
      const targetIndex = detail.conversation_messages.findIndex(
        (message) => message.search_ordinal === detail.search_target
      );
      const target = elements.conversationList.querySelector(
        `#message-${targetIndex + 1}`
      );
      // 工具结果可能是合并卡内的锚点，折叠状态要落到所属卡片上。
      const card = target?.closest(".message-card");
      if (card?.classList.contains("collapsed"))
        card.querySelector(".message-toggle")?.click();
      target?.scrollIntoView({ block: "center" });
    }
    if (liveScroll && scroller && scroller.scrollTop === liveScroll.top) {
      requestAnimationFrame(() => {
        if (
          !request.isCurrent() ||
          state.selectedSessionKey !== id ||
          scroller.scrollTop !== liveScroll.top
        )
          return;
        scroller.scrollTop = liveScroll.atBottom
          ? scroller.scrollHeight
          : Math.min(liveScroll.top, scroller.scrollHeight);
      });
    }
    renderRawEvents(detail.raw_events);
    updateTabs();
    // 初始化恢复的首条详情不滚动：此时 _initialized 已置 true，
    // 但移动端首屏应停留在列表，只有用户后续的详情切换才滚过去。
    if (
      !initial &&
      !live &&
      state._initialized &&
      window.matchMedia(MOBILE_LAYOUT_QUERY).matches
    ) {
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

// 会话仍被选中且源文件在刷新后有新内容时重载详情，保持滚动位置。
// search_context 是定位局部视图，不自动重载；removed 会话内容仍可读。
export async function refreshOpenDetailIfChanged() {
  const detail = state.currentDetail;
  const key = detail?.summary?._key;
  if (!key || detail.search_context || state.selectedSessionKey !== key) {
    return false;
  }
  const fresh = state.sessions.find((item) => item._key === key);
  if (!sessionNeedsLiveReload(fresh, detail.summary)) return false;
  return loadSessionDetail(key, { silent: true, live: true });
}
export async function loadSessions({
  reportError = true,
  background = false,
} = {}) {
  const request = sessionRequestGate.begin();
  // 与 refreshWorkspace 的 query 分支同口径：失效查询时取消在途统计请求，
  // 否则旧 stats 响应完成后会写回旧数据并清掉 statsDirty，统计页长期陈旧。
  if (!background)
    invalidateQuery(state, [statsRequestGate, statsSessionsRequestGate]);
  if (!background) detailRequestGate.cancel();
  state.lastSessionError = null;
  state.sessionsLoading = true;
  syncFilterControls();
  renderSessionListFooter();
  try {
    let data;
    if (isSearchActive()) {
      data = await fetchJson(buildSearchUrl(), { signal: request.signal });
      if (!request.isCurrent()) return false;
    } else {
      data = await fetchJson(buildSessionsUrl(), { signal: request.signal });
      if (!request.isCurrent()) return false;
    }
    state.sessionsLoading = false;
    state.sessionsDirty = false;
    applySessionPage(state, data, isSearchActive());
    if (data.session_roots) {
      state.facets = { ...state.facets, session_roots: data.session_roots };
    }
    state.scanning = data.scanning === true;
    document
      .querySelector("#search-sort")
      ?.classList.toggle("hidden", !isSearchActive());
    document
      .querySelector("#search-results-toolbar")
      ?.classList.toggle("hidden", !isSearchActive() && !hasSearchOptions());
    const searchCount = document.querySelector("#search-result-count");
    if (searchCount)
      searchCount.textContent = isSearchActive()
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
      // 首条详情不阻塞列表渲染与 _initialized：详情 IPC 与整页渲染
      // 在后台完成，失败回退逻辑在调度时快照初始化状态。
      const restoreKey = state.selectedSessionKey;
      const initializing = !state._initialized;
      if (
        background &&
        !keepingOffscreenSelection &&
        state.currentDetail?.summary?._key === restoreKey
      ) {
        await refreshOpenDetailIfChanged();
      } else
        void (async () => {
          const loaded = await loadSessionDetail(restoreKey, {
            silent: keepingOffscreenSelection,
            initial: initializing,
            live:
              background && state.currentDetail?.summary?._key === restoreKey,
          });
          if (
            keepingOffscreenSelection &&
            !loaded &&
            request.isCurrent() &&
            // 加载期间用户手动选择了其他会话时不回退
            state.selectedSessionKey === restoreKey
          ) {
            if (initializing) {
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
                await loadSessionDetail(first._key, { initial: initializing });
              }
            } else {
              // 后台刷新时目标会话已被删除：清除选择并显示占位
              state.selectedSessionKey = null;
              state.currentDetail = null;
              showSelectSessionPlaceholder();
            }
          }
        })();
    } else {
      showSelectSessionPlaceholder();
    }
    if (request.isCurrent() && state._initialized) syncUrl();
    return request.isCurrent();
  } catch (error) {
    if (isAbortError(error) || !request.isCurrent()) return false;
    console.error(error);
    state.sessionsLoading = false;
    state.lastSessionError = error;
    renderSessionListFooter();
    if (reportError) {
      showError(`${t("loadListFailed")}: ${error.message}`);
    }
    return false;
  }
}

export async function loadMoreSessions() {
  if (state.sessionsLoading || state.lastSessionError) return false;
  const request = sessionRequestGate.begin();
  try {
    const url = isSearchActive()
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

export function renderCurrentStats() {
  if (!state.stats) return;
  renderStats(state.stats, elements, {
    onSelectDay: (date) =>
      setActivityRange({ start: date, end: date })
        .then(() => {
          elements.tokenHeatmapBody
            ?.querySelector(`[data-date="${date}"]`)
            ?.focus();
        })
        .catch((error) => showError(error.message)),
    onChangeRange: (range) =>
      setActivityRange(range).catch((error) => showError(error.message)),
    onSelectSession: (key) => {
      openReviewSession(key).catch((error) => showError(error.message));
    },
    onSelectRanking: (kind, value) => {
      openActivitySearch(kind, value).catch((error) =>
        showError(error.message)
      );
    },
  });
  renderRelatedSessions();
}

function renderRelatedSessions() {
  renderStatsSessionList(
    elements.statsSessions,
    {
      data: state.statsSessions,
      sort: state.statsSessionsSort,
      loading: state.statsSessionsLoading,
      error: state.statsSessionsError,
    },
    {
      onSelectSession: (key) =>
        openReviewSession(key).catch((error) => showError(error.message)),
      onSort: (sort) => {
        state.statsSessionsSort = sort;
        void loadStatsSessions();
      },
      onMore: () => {
        void loadStatsSessions({ append: true });
      },
      onRetry: () => {
        void loadStatsSessions({
          append: state.statsSessionsError?.append === true,
        });
      },
    }
  );
}

export async function loadStatsSessions({ append = false } = {}) {
  const request = statsSessionsRequestGate.begin();
  const previous = append ? state.statsSessions : null;
  if (!append) state.statsSessions = null;
  state.statsSessionsLoading = true;
  state.statsSessionsError = null;
  renderRelatedSessions();
  try {
    const params = new URLSearchParams(buildSessionQuery());
    params.set("sort", state.statsSessionsSort);
    params.set("limit", "20");
    if (previous?.next_cursor) params.set("cursor", previous.next_cursor);
    const data = await fetchJson(`/api/stats/sessions?${params}`, {
      signal: request.signal,
    });
    if (!request.isCurrent()) return false;
    state.statsSessions = {
      ...data,
      sessions: [...(previous?.sessions || []), ...data.sessions],
    };
    return true;
  } catch (error) {
    if (isAbortError(error) || !request.isCurrent()) return false;
    state.statsSessionsError = { message: error.message, append };
    return false;
  } finally {
    if (request.isCurrent()) {
      state.statsSessionsLoading = false;
      renderRelatedSessions();
    }
  }
}

export async function loadStats() {
  state.statsDirty = true;
  if (state.activeView !== "stats") {
    statsRequestGate.cancel();
    statsSessionsRequestGate.cancel();
    return true;
  }
  const request = statsRequestGate.begin();
  statsSessionsRequestGate.cancel();
  state.statsSessions = null;
  state.statsSessionsLoading = false;
  state.statsSessionsError = null;
  renderRelatedSessions();
  try {
    const params = buildSessionQuery();
    const url = `/api/stats${params ? "?" + params : ""}`;
    const stats = await fetchJson(url, { signal: request.signal });
    if (!request.isCurrent()) return false;
    state.stats = stats;
    state.statsDirty = false;
    renderCurrentStats();
    if (state.activeView === "stats") void loadStatsSessions();
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
  const request = facetsRequestGate.begin();
  const query = buildFacetsQuery();
  let facets;
  try {
    facets = await fetchJson(`/api/facets${query ? `?${query}` : ""}`, {
      signal: request.signal,
    });
  } catch (error) {
    if (isAbortError(error)) return;
    throw error;
  }
  if (!request.isCurrent()) return;
  state.facets = facets;
  syncSessionRoot();
  updateFacetFilters();
  syncFilterControls();
}

const facetsRequestGate = createLatestRequestGate();
const queueWorkspaceRefresh = createRefreshCoordinator(async (scopes) => {
  recordMetric("refresh.rounds");
  const metadata = [];
  if (scopes.has("facets")) metadata.push(loadFacets());
  if (scopes.has("diagnostics")) metadata.push(loadWorkspaceDiagnostics());
  const metadataResults = await Promise.allSettled(metadata);
  const work = [];
  if (scopes.has("sessions") || scopes.has("query")) {
    if (!scopes.has("query") && state.activeView !== "list") {
      // 非列表视图只标脏；同时取消在途列表请求，否则旧响应完成后会
      // 写回旧页并清掉脏标记，回到列表页不再重载（丢更新）。
      state.sessionsDirty = true;
      sessionRequestGate.cancel();
    } else work.push(loadSessions({ background: !scopes.has("query") }));
  }
  if (scopes.has("stats")) work.push(loadStats());
  const results = await Promise.allSettled(work);
  const failure = [...metadataResults, ...results].find(
    (result) => result.status === "rejected"
  );
  if (failure) throw failure.reason;
});

export function refreshWorkspace(scopes) {
  if (scopes.includes("query")) {
    invalidateQuery(state, [
      sessionRequestGate,
      detailRequestGate,
      statsRequestGate,
      statsSessionsRequestGate,
    ]);
  }
  return queueWorkspaceRefresh(scopes);
}

export async function loadWorkspaceDiagnostics() {
  const payload = await fetchJson("/api/settings");
  state.diagnostics = payload?.diagnostics || null;
  state.watcherStatus = payload?.watcher || null;
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
