// 会话列表:分组渲染、增量追加、选中联动与批量选择工具栏。
import { t } from "../i18n.js";
import { highlightMatches } from "../search-view.js";
import {
  cwdParts,
  formatDateGroup,
  formatListTimestamp,
  formatTimestamp,
  providerLabel,
  sessionTimestamp,
} from "../session-format.js";
import {
  MOBILE_LAYOUT_QUERY,
  compactSourceLabel,
  detailRequestGate,
  displaySourceLabel,
  elements,
  hiddenReasonLabel,
  sessionWorkspace,
  sourceKindValue,
  state,
  visibleSessions,
} from "./shared.js";
import { renderActiveFilters, syncUrl } from "./filters.js";
import { setDetailPlaceholder, setPropsPlaceholder } from "./detail-view.js";
import { loadMoreSessions, loadSessionDetail } from "./data.js";

export function updateBulkToolbar() {
  const count = state.selectedSessionKeys.size;
  elements.bulkToolbar?.classList.toggle("hidden", count === 0);
  if (elements.selectVisibleBtn) {
    elements.selectVisibleBtn.disabled = state.sessions.length === 0;
  }
  if (elements.bulkSelectionCount) {
    elements.bulkSelectionCount.textContent = count
      ? t("selectedSessionsCount", { n: count })
      : t("noSessionsSelected");
  }
  elements.bulkActions?.classList.toggle("hidden", count === 0);
}

export function setSessionSelected(sessionKey, selected) {
  if (selected) state.selectedSessionKeys.add(sessionKey);
  else state.selectedSessionKeys.delete(sessionKey);
  const row = elements.sessionList
    ?.querySelector(
      `.session-item[data-session-key="${CSS.escape(sessionKey)}"]`
    )
    ?.closest(".session-row");
  row?.classList.toggle("is-selected", selected);
  const checkbox = row?.querySelector(".session-select-checkbox");
  if (checkbox) checkbox.checked = selected;
  updateBulkToolbar();
}
export function updateSessionCount() {
  const visibleCount = visibleSessions().length;
  const statsTotal = Number(state.stats?.total);
  if (visibleCount === 0) {
    elements.sessionCount.textContent = "0";
    return;
  }
  elements.sessionCount.textContent = Number.isFinite(statsTotal)
    ? String(statsTotal)
    : `${visibleCount}${state.hasMore ? "+" : ""}`;
}
let renderedSessionCount = 0;
let lastRenderedGroupKey = "";

export function shouldGroupSessions() {
  return !state.searchQuery || state.searchSort === "recent";
}

export function sessionGroupCounts(sessions) {
  const counts = new Map();
  sessions.forEach((session) => {
    const key = formatDateGroup(sessionTimestamp(session)).key;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}

export function appendSessionBatch(sessions, counts) {
  sessions.forEach((session) => {
    const group = formatDateGroup(sessionTimestamp(session));
    if (shouldGroupSessions() && group.key !== lastRenderedGroupKey) {
      lastRenderedGroupKey = group.key;
      appendSessionGroupHeader(group.label, counts.get(group.key) || 0);
    }
    appendSessionItems([session]);
  });
}

export function renderSessionListFooter() {
  renderLoadMoreButton();
  updateSessionCount();
  updateBulkToolbar();
}

export function appendLoadedSessions(added) {
  const visible = visibleSessions();
  if (visible.length - added.length !== renderedSessionCount) {
    renderSessionList();
    return;
  }
  const counts = sessionGroupCounts(visible);
  if (
    shouldGroupSessions() &&
    added.length &&
    formatDateGroup(sessionTimestamp(added[0])).key === lastRenderedGroupKey
  ) {
    const headers = elements.sessionList.querySelectorAll(
      ".session-group-header"
    );
    const lastHeader = headers[headers.length - 1];
    if (lastHeader?.lastElementChild) {
      lastHeader.lastElementChild.textContent = t("groupSessionCount", {
        n: counts.get(lastRenderedGroupKey) || 0,
      });
    }
  }
  appendSessionBatch(added, counts);
  renderedSessionCount = visible.length;
  renderSessionListFooter();
}

export function appendSessionGroupHeader(label, count) {
  const header = document.createElement("div");
  header.className = "session-group-header";
  header.setAttribute("role", "presentation");
  const title = document.createElement("span");
  title.textContent = label;
  const meta = document.createElement("span");
  meta.textContent = t("groupSessionCount", { n: count });
  header.append(title, meta);
  elements.sessionList.append(header);
}

export function appendSessionItems(sessions) {
  sessions.forEach((session) => {
    const workspace = sessionWorkspace(session);
    const archived = workspace.archived === true;
    const removed = workspace.removed === true;

    const fragment = elements.sessionItemTemplate.content.cloneNode(true);
    const row = fragment.querySelector(".session-row");
    const button = fragment.querySelector(".session-item");
    const sourceKind = sourceKindValue(session);
    row.dataset.sourceKind = sourceKind;
    button.dataset.sourceKind = sourceKind;
    button.dataset.sessionKey = session._key;
    const checkbox = fragment.querySelector(".session-select-checkbox");
    checkbox.checked = state.selectedSessionKeys.has(session._key);
    checkbox.setAttribute("aria-label", t("selectSessionForBulk"));
    row.classList.toggle("is-selected", checkbox.checked);
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      setSessionSelected(session._key, checkbox.checked);
    });
    button.setAttribute("role", "option");
    button.setAttribute(
      "aria-selected",
      session._key === state.selectedSessionKey ? "true" : "false"
    );
    const title = session.title || cwdParts(session.cwd).main || session.id;
    const preview = session.search_snippet
      ? `${t("searchMatch")}: ${session.search_snippet}`
      : session.preview_text || "";
    const titleEl = button.querySelector(".session-title");
    titleEl.textContent = title;
    titleEl.title = title;
    const timeEl = button.querySelector(".session-time");
    timeEl.textContent = formatListTimestamp(sessionTimestamp(session));
    timeEl.title = formatTimestamp(sessionTimestamp(session));
    button.querySelector(".session-provider").textContent =
      providerLabel(session);
    const pathParts = cwdParts(session.cwd);
    const cwdMain = button.querySelector(".session-cwd-main");
    const cwdPath = button.querySelector(".session-cwd-path");
    cwdMain.textContent = pathParts.main;
    cwdMain.title = session.cwd || "";
    if (cwdPath) {
      const bdi = document.createElement("bdi");
      bdi.textContent = pathParts.path;
      cwdPath.replaceChildren(bdi);
      cwdPath.title = session.cwd || "";
      cwdPath.classList.toggle("hidden", !pathParts.path);
    }
    const previewEl = button.querySelector(".session-preview");
    previewEl.textContent = preview;
    previewEl.title = preview;
    previewEl.classList.toggle("hidden", !preview);
    cwdMain.classList.remove("hidden");
    if (cwdPath) cwdPath.classList.toggle("hidden", !pathParts.path);
    button.querySelector(".session-source").textContent =
      session.source || session.originator || t("unknownSource");
    const sourceKindEl = button.querySelector(".session-source-kind");
    const sourceLabel = displaySourceLabel(session);
    sourceKindEl.textContent = compactSourceLabel(sourceLabel);
    sourceKindEl.title = sourceLabel;
    sourceKindEl.dataset.sourceKind = sourceKind;
    const messageCount = Number(session.message_count || 0);
    const messageCountEl = button.querySelector(".session-message-count");
    messageCountEl.textContent = String(messageCount);
    messageCountEl.title = t("sessionMessageCount", { n: messageCount });
    messageCountEl.setAttribute(
      "aria-label",
      t("sessionMessageCount", { n: messageCount })
    );
    const hiddenReason = hiddenReasonLabel(session);
    if (hiddenReason) {
      const hiddenBadge = document.createElement("span");
      hiddenBadge.className = "session-hidden-reason";
      hiddenBadge.textContent = hiddenReason;
      button.querySelector(".session-tertiary").append(hiddenBadge);
    }
    if (workspace.favorite === true) {
      const favoriteBadge = document.createElement("span");
      favoriteBadge.className = "session-workspace-badge favorite";
      favoriteBadge.textContent = t("favorite");
      button.querySelector(".session-tertiary").append(favoriteBadge);
    }
    (workspace.tags || []).slice(0, 2).forEach((tag) => {
      const tagBadge = document.createElement("span");
      tagBadge.className = "session-workspace-badge";
      tagBadge.textContent = tag;
      button.querySelector(".session-tertiary").append(tagBadge);
    });
    if ((workspace.tags || []).length > 2) {
      const moreBadge = document.createElement("span");
      moreBadge.className = "session-workspace-badge";
      moreBadge.textContent = `+${workspace.tags.length - 2}`;
      button.querySelector(".session-tertiary").append(moreBadge);
    }
    if (session._key === state.selectedSessionKey) {
      button.classList.add("active");
    }
    if (archived) {
      button.classList.add("archived");
    }
    if (removed) {
      button.classList.add("removed");
      const removedBadge = document.createElement("span");
      removedBadge.className = "session-hidden-reason";
      removedBadge.textContent = t("removedSession");
      button.querySelector(".session-tertiary").append(removedBadge);
    }

    button.addEventListener("click", () => {
      selectSession(session._key, button);
    });
    if (session.search_hits?.length) {
      const hits = document.createElement("div");
      hits.className = "search-hit-list";
      previewEl.classList.add("hidden");
      for (const hit of session.search_hits) {
        const link = document.createElement("button");
        link.type = "button";
        link.className = "search-hit";
        const label = document.createElement("span");
        label.className = "search-hit-field";
        label.textContent = t(`searchField_${hit.field}`);
        const excerpt = document.createElement("span");
        excerpt.textContent = hit.snippet;
        highlightMatches(excerpt, state.searchQuery);
        link.append(label, excerpt);
        link.addEventListener("click", () =>
          selectSession(session._key, button, hit)
        );
        hits.append(link);
      }
      row.append(hits);
    }
    elements.sessionList.append(fragment);
  });
}

export function selectSession(key, buttonEl, hit = null) {
  const selectedHit =
    hit ||
    state.sessions
      .find((session) => session._key === key)
      ?.search_hits?.find((item) => Number.isInteger(item.ordinal));
  state.selectedSearchHit = selectedHit
    ? { ...selectedHit, sessionKey: key }
    : null;
  state.selectedSessionKey = key;
  state.currentDetail = null;
  setPropsPlaceholder(t("loading"));
  detailRequestGate.cancel();
  elements.sessionList.querySelectorAll(".session-item").forEach((el) => {
    el.classList.remove("active");
    el.setAttribute("aria-selected", "false");
  });
  if (buttonEl) {
    buttonEl.classList.add("active");
    buttonEl.setAttribute("aria-selected", "true");
  }
  elements.detailView.classList.add("hidden");
  elements.detailEmpty.classList.remove("hidden");
  setDetailPlaceholder(t("loading"));
  if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
    if (elements.sidebarFilters) elements.sidebarFilters.open = false;
    if (elements.projectNav) elements.projectNav.open = false;
  }
  syncUrl();
  loadSessionDetail(key);
}

export function renderLoadMoreButton() {
  let btn = elements.sessionList.querySelector(".load-more-btn");
  if (btn) btn.remove();

  if (!state.hasMore) return;

  btn = document.createElement("button");
  btn.className = "ghost-button load-more-btn";
  btn.textContent = t("loadMore");
  btn.addEventListener("click", async () => {
    btn.textContent = t("loadingMore");
    btn.disabled = true;
    const loaded = await loadMoreSessions();
    if (!loaded && btn.isConnected) {
      btn.textContent = t("loadMore");
      btn.disabled = false;
    }
  });
  elements.sessionList.append(btn);
}

export function renderSessionList() {
  elements.sessionList.innerHTML = "";
  renderedSessionCount = 0;
  lastRenderedGroupKey = "";
  renderActiveFilters();

  const visible = visibleSessions();

  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "hero-copy";
    empty.textContent = t(state.scanning ? "scanningSessions" : "noResults");
    elements.sessionList.append(empty);
    renderSessionListFooter();
    return;
  }

  renderedSessionCount = visible.length;
  appendSessionBatch(visible, sessionGroupCounts(visible));
  renderSessionListFooter();
}
