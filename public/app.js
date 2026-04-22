const PAGE_LIMIT = 50;
const ARCHIVE_KEY = "codex_viewer_archived_sessions";

const state = {
  facets: null,
  sessions: [],
  selectedSessionId: null,
  activeTab: "conversation",
  hasMore: false,
  nextCursor: null,
  searchQuery: "",
  showArchived: false,
  currentDetail: null,
  filters: {
    provider: "",
    date: "",
    cwd: ""
  }
};

function getArchivedIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function setArchivedIds(set) {
  localStorage.setItem(ARCHIVE_KEY, JSON.stringify(Array.from(set)));
}

function toggleArchive(id) {
  const ids = getArchivedIds();
  if (ids.has(id)) {
    ids.delete(id);
  } else {
    ids.add(id);
  }
  setArchivedIds(ids);
}

const elements = {
  sessionRoot: document.querySelector("#session-root"),
  sessionCount: document.querySelector("#session-count"),
  providerFilter: document.querySelector("#provider-filter"),
  dateFilter: document.querySelector("#date-filter"),
  cwdFilter: document.querySelector("#cwd-filter"),
  searchInput: document.querySelector("#search-input"),
  resetFilters: document.querySelector("#reset-filters"),
  refreshBtn: document.querySelector("#refresh-btn"),
  showArchivedToggle: document.querySelector("#show-archived-toggle"),
  sessionList: document.querySelector("#session-list"),
  detailEmpty: document.querySelector("#detail-empty"),
  detailView: document.querySelector("#detail-view"),
  detailTitle: document.querySelector("#detail-title"),
  detailSummary: document.querySelector("#detail-summary"),
  conversationList: document.querySelector("#conversation-list"),
  rawEvents: document.querySelector("#raw-events"),
  conversationTab: document.querySelector("#conversation-tab"),
  rawTab: document.querySelector("#raw-tab"),
  tabButtons: Array.from(document.querySelectorAll(".tab-button")),
  exportMdBtn: document.querySelector("#export-md-btn"),
  exportJsonBtn: document.querySelector("#export-json-btn"),
  statsContent: document.querySelector("#stats-content"),
  sessionItemTemplate: document.querySelector("#session-item-template"),
  conversationItemTemplate: document.querySelector("#conversation-item-template"),
  rawEventTemplate: document.querySelector("#raw-event-template")
};

// ── URL 状态同步 ──────────────────────────────────────────────────────────────
function syncUrl() {
  const params = new URLSearchParams();
  if (state.filters.provider) params.set("provider", state.filters.provider);
  if (state.filters.date) params.set("date", state.filters.date);
  if (state.filters.cwd) params.set("cwd", state.filters.cwd);
  if (state.searchQuery) params.set("q", state.searchQuery);
  if (state.selectedSessionId) params.set("session", state.selectedSessionId);
  const search = params.toString();
  history.replaceState(null, "", search ? `?${search}` : location.pathname);
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  state.filters.provider = params.get("provider") || "";
  state.filters.date = params.get("date") || "";
  state.filters.cwd = params.get("cwd") || "";
  state.searchQuery = params.get("q") || "";
  state.selectedSessionId = params.get("session") || null;
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function formatTimestamp(value) {
  if (!value) {
    return "未知时间";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function fillSelect(select, values) {
  const currentValue = select.value;
  select.innerHTML = "";
  select.append(createOption("", "全部"));
  values.forEach((value) => {
    select.append(createOption(value, value));
  });
  select.value = values.includes(currentValue) ? currentValue : "";
}

function updateFacetFilters() {
  if (!state.facets) {
    return;
  }

  fillSelect(elements.providerFilter, state.facets.providers);
  fillSelect(elements.dateFilter, state.facets.dates);
  fillSelect(elements.cwdFilter, state.facets.cwds);
}

function buildSessionQuery() {
  const params = new URLSearchParams();
  Object.entries(state.filters).forEach(([key, value]) => {
    if (value) {
      params.set(key, value);
    }
  });
  return params.toString();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(errorBody || `请求失败: ${response.status}`);
  }
  return response.json();
}

function appendSessionItems(sessions) {
  const archivedIds = getArchivedIds();
  sessions.forEach((session) => {
    const archived = archivedIds.has(session.id);
    if (archived && !state.showArchived) return;

    const fragment = elements.sessionItemTemplate.content.cloneNode(true);
    const button = fragment.querySelector(".session-item");
    button.dataset.sessionId = session.id;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", session.id === state.selectedSessionId ? "true" : "false");
    button.querySelector(".session-time").textContent = formatTimestamp(
      session.timestamp || session.last_timestamp
    );
    button.querySelector(".session-provider").textContent = session.model_provider || "unknown";
    button.querySelector(".session-cwd").textContent = session.cwd || "(无工作目录)";
    button.querySelector(".session-events").textContent = `${session.event_count} 条事件`;
    button.querySelector(".session-source").textContent = session.source || session.originator || "未知来源";
    if (session.id === state.selectedSessionId) {
      button.classList.add("active");
    }
    if (archived) {
      button.classList.add("archived");
    }

    const archiveBtn = document.createElement("button");
    archiveBtn.className = "session-archive-btn";
    archiveBtn.title = archived ? "取消归档" : "归档此会话";
    archiveBtn.textContent = archived ? "↩" : "⊗";
    archiveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleArchive(session.id);
      renderSessionList();
    });
    button.append(archiveBtn);

    button.addEventListener("click", () => {
      selectSession(session.id, button);
    });
    elements.sessionList.append(fragment);
  });
}

function selectSession(id, buttonEl) {
  state.selectedSessionId = id;
  elements.sessionList.querySelectorAll(".session-item").forEach((el) => {
    el.classList.remove("active");
    el.setAttribute("aria-selected", "false");
  });
  if (buttonEl) {
    buttonEl.classList.add("active");
    buttonEl.setAttribute("aria-selected", "true");
  }
  syncUrl();
  loadSessionDetail(id);
}

function renderLoadMoreButton() {
  let btn = elements.sessionList.querySelector(".load-more-btn");
  if (btn) btn.remove();

  if (!state.hasMore) return;

  btn = document.createElement("button");
  btn.className = "ghost-button load-more-btn";
  btn.textContent = "加载更多";
  btn.addEventListener("click", async () => {
    btn.textContent = "加载中...";
    btn.disabled = true;
    await loadMoreSessions();
  });
  elements.sessionList.append(btn);
}

function renderSessionList() {
  elements.sessionList.innerHTML = "";

  const archivedIds = getArchivedIds();
  const visible = state.sessions.filter((s) => state.showArchived || !archivedIds.has(s.id));

  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "hero-copy";
    empty.textContent = "当前筛选条件下没有会话。";
    elements.sessionList.append(empty);
    elements.sessionCount.textContent = "0";
    return;
  }

  appendSessionItems(state.sessions);
  renderLoadMoreButton();
  elements.sessionCount.textContent = String(visible.length);
}

// ── 导出功能 ──────────────────────────────────────────────────────────────────
function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function exportSessionMarkdown(detail) {
  const { summary, conversation_messages: messages } = detail;
  const lines = [
    `# 会话: ${summary.cwd || summary.id}`,
    ``,
    `- **时间**: ${formatTimestamp(summary.timestamp)}`,
    `- **Provider**: ${summary.model_provider || "unknown"}`,
    `- **来源**: ${summary.source || summary.originator || "-"}`,
    `- **会话 ID**: ${summary.id}`,
    ``
  ];
  messages.forEach((msg) => {
    lines.push(`## ${msg.role}`);
    lines.push(``);
    lines.push(msg.text);
    lines.push(``);
  });
  const filename = `session-${summary.id.slice(0, 12)}.md`;
  downloadBlob(lines.join("\n"), filename, "text/markdown; charset=utf-8");
}

function exportSessionJson(detail) {
  const filename = `session-${detail.summary.id.slice(0, 12)}.json`;
  downloadBlob(JSON.stringify(detail, null, 2), filename, "application/json; charset=utf-8");
}

// ── 摘要渲染 ──────────────────────────────────────────────────────────────────
function renderSummaryGrid(summary) {
  elements.detailSummary.innerHTML = "";
  const entries = [
    ["Provider", summary.model_provider || "unknown"],
    ["开始时间", formatTimestamp(summary.timestamp)],
    ["最后时间", formatTimestamp(summary.last_timestamp)],
    ["来源", summary.source || summary.originator || "-"],
    ["发起端", summary.originator || "-"],
    ["工作目录", summary.cwd || "-"],
    ["事件数", String(summary.event_count)],
    ["会话 ID", summary.id],
    ["文件路径", summary.file_path]
  ];

  entries.forEach(([label, value]) => {
    const card = document.createElement("article");
    const title = document.createElement("dt");
    const body = document.createElement("dd");
    title.textContent = label;
    body.textContent = value || "-";
    card.append(title, body);
    elements.detailSummary.append(card);
  });
}

function renderConversation(messages) {
  elements.conversationList.innerHTML = "";

  if (!messages.length) {
    const empty = document.createElement("p");
    empty.className = "hero-copy";
    empty.textContent = "这个会话没有可整理的对话消息，建议切到原始事件流查看。";
    elements.conversationList.append(empty);
    return;
  }

  messages.forEach((message) => {
    const fragment = elements.conversationItemTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".message-card");
    card.dataset.role = message.role;
    fragment.querySelector(".message-role").textContent = message.role;
    fragment.querySelector(".message-time").textContent = formatTimestamp(message.timestamp);
    fragment.querySelector(".message-text").textContent = message.text;

    const copyBtn = document.createElement("button");
    copyBtn.className = "message-copy-btn";
    copyBtn.title = "复制消息内容";
    copyBtn.textContent = "复制";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(message.text).then(() => {
        copyBtn.textContent = "✓";
        setTimeout(() => { copyBtn.textContent = "复制"; }, 1500);
      }).catch(() => {
        copyBtn.textContent = "失败";
        setTimeout(() => { copyBtn.textContent = "复制"; }, 1500);
      });
    });
    fragment.querySelector(".message-card header").append(copyBtn);

    elements.conversationList.append(fragment);
  });
}

function renderRawEvents(events) {
  elements.rawEvents.innerHTML = "";

  events.forEach((event) => {
    const fragment = elements.rawEventTemplate.content.cloneNode(true);
    fragment.querySelector(".raw-event-type").textContent = event.type;
    fragment.querySelector(".raw-event-time").textContent = formatTimestamp(event.timestamp);
    fragment.querySelector(".raw-event-line").textContent = `第 ${event.line_number} 行`;
    fragment.querySelector(".raw-event-payload").textContent = JSON.stringify(
      event.payload,
      null,
      2
    );
    elements.rawEvents.append(fragment);
  });
}

function updateTabs() {
  elements.tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === state.activeTab;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  elements.conversationTab.classList.toggle("hidden", state.activeTab !== "conversation");
  elements.rawTab.classList.toggle("hidden", state.activeTab !== "raw");
}

let errorTimer = null;
function showError(message) {
  let banner = document.querySelector("#error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "error-banner";
    banner.className = "error-banner";
    document.querySelector(".page-shell").prepend(banner);
  }
  banner.textContent = message;
  banner.classList.remove("hidden");
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    banner.classList.add("hidden");
  }, 5000);
}

async function loadSessionDetail(id) {
  try {
    const detail = await fetchJson(`/api/sessions/${encodeURIComponent(id)}`);
    state.currentDetail = detail;
    elements.detailEmpty.classList.add("hidden");
    elements.detailView.classList.remove("hidden");
    elements.detailTitle.textContent = detail.summary.cwd || "未记录工作目录";
    renderSummaryGrid(detail.summary);
    renderConversation(detail.conversation_messages);
    renderRawEvents(detail.raw_events);
    updateTabs();
  } catch (error) {
    console.error(error);
    showError(`加载会话详情失败: ${error.message}`);
  }
}

async function loadSessions() {
  try {
    let data;
    if (state.searchQuery) {
      data = await fetchJson(`/api/search?q=${encodeURIComponent(state.searchQuery)}`);
      state.sessions = data.sessions;
      state.hasMore = false;
      state.nextCursor = null;
    } else {
      const query = buildSessionQuery();
      const sep = query ? "&" : "?";
      const url = `/api/sessions${query ? `?${query}` : ""}${sep}limit=${PAGE_LIMIT}`;
      data = await fetchJson(url);
      state.sessions = data.sessions;
      state.hasMore = data.has_more;
      state.nextCursor = data.next_cursor;
    }
    elements.sessionRoot.textContent = data.session_root || "";

    if (state.selectedSessionId && !state.sessions.find((session) => session.id === state.selectedSessionId)) {
      state.selectedSessionId = null;
    }

    renderSessionList();

    if (!state.selectedSessionId && state.sessions[0]) {
      const archivedIds = getArchivedIds();
      const first = state.sessions.find((s) => !archivedIds.has(s.id)) || state.sessions[0];
      state.selectedSessionId = first.id;
    }

    if (state.selectedSessionId) {
      elements.sessionList.querySelectorAll(".session-item").forEach((el) => {
        el.classList.toggle("active", el.dataset.sessionId === state.selectedSessionId);
      });
      await loadSessionDetail(state.selectedSessionId);
    } else {
      elements.detailView.classList.add("hidden");
      elements.detailEmpty.classList.remove("hidden");
    }
    syncUrl();
  } catch (error) {
    console.error(error);
    showError(`加载会话列表失败: ${error.message}`);
  }
}

async function loadMoreSessions() {
  try {
    const query = buildSessionQuery();
    const sep = query ? "&" : "?";
    const url = `/api/sessions${query ? `?${query}` : ""}${sep}limit=${PAGE_LIMIT}&cursor=${state.nextCursor}`;
    const data = await fetchJson(url);
    state.sessions = state.sessions.concat(data.sessions);
    state.hasMore = data.has_more;
    state.nextCursor = data.next_cursor;

    const loadMoreBtn = elements.sessionList.querySelector(".load-more-btn");
    if (loadMoreBtn) loadMoreBtn.remove();

    appendSessionItems(data.sessions);
    renderLoadMoreButton();
    elements.sessionCount.textContent = String(state.sessions.length);
  } catch (error) {
    console.error(error);
    showError(`加载更多失败: ${error.message}`);
  }
}

// ── 统计面板 ──────────────────────────────────────────────────────────────────
function renderBar(label, count, max) {
  const row = document.createElement("div");
  row.className = "stats-bar-row";
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  const labelEl = document.createElement("span");
  labelEl.className = "stats-bar-label";
  labelEl.title = label;
  labelEl.textContent = label;
  const track = document.createElement("div");
  track.className = "stats-bar-track";
  const fill = document.createElement("div");
  fill.className = "stats-bar-fill";
  fill.style.width = `${pct}%`;
  track.append(fill);
  const countEl = document.createElement("span");
  countEl.className = "stats-bar-count";
  countEl.textContent = String(count);
  row.append(labelEl, track, countEl);
  return row;
}

function renderStats(stats) {
  const c = elements.statsContent;
  if (!c) return;
  c.innerHTML = "";
  const sections = [
    { title: "近期每日会话数", items: (stats.by_date || []).slice(0, 14) },
    { title: "常用 Provider", items: stats.by_provider || [] },
    { title: "常用工作目录", items: (stats.by_cwd || []).slice(0, 8) }
  ];
  sections.forEach(({ title, items }) => {
    if (!items.length) return;
    const section = document.createElement("div");
    section.className = "stats-section";
    const h = document.createElement("h3");
    h.textContent = title;
    section.append(h);
    const max = Math.max(...items.map((i) => i.count));
    items.forEach(({ label, count }) => section.append(renderBar(label, count, max)));
    c.append(section);
  });
}

async function loadStats() {
  try {
    const stats = await fetchJson("/api/stats");
    renderStats(stats);
  } catch { /* 统计面板加载失败时静默处理 */ }
}

async function initialize() {
  restoreFromUrl();

  state.facets = await fetchJson("/api/facets");
  elements.sessionRoot.textContent = state.facets.session_root;
  updateFacetFilters();

  if (state.filters.provider) elements.providerFilter.value = state.filters.provider;
  if (state.filters.date) elements.dateFilter.value = state.filters.date;
  if (state.filters.cwd) elements.cwdFilter.value = state.filters.cwd;
  if (state.searchQuery) elements.searchInput.value = state.searchQuery;

  await loadStats();

  elements.providerFilter.addEventListener("change", async (event) => {
    state.filters.provider = event.target.value;
    syncUrl();
    await loadSessions();
  });

  elements.dateFilter.addEventListener("change", async (event) => {
    state.filters.date = event.target.value;
    syncUrl();
    await loadSessions();
  });

  elements.cwdFilter.addEventListener("change", async (event) => {
    state.filters.cwd = event.target.value;
    syncUrl();
    await loadSessions();
  });

  elements.resetFilters.addEventListener("click", async () => {
    state.filters = { provider: "", date: "", cwd: "" };
    state.searchQuery = "";
    elements.providerFilter.value = "";
    elements.dateFilter.value = "";
    elements.cwdFilter.value = "";
    elements.searchInput.value = "";
    syncUrl();
    await loadSessions();
  });

  if (elements.refreshBtn) {
    elements.refreshBtn.addEventListener("click", async () => {
      elements.refreshBtn.disabled = true;
      elements.refreshBtn.textContent = "刷新中...";
      try {
        await fetchJson("/api/refresh");
        await Promise.all([loadSessions(), loadStats()]);
      } catch (error) {
        showError(`刷新失败: ${error.message}`);
      } finally {
        elements.refreshBtn.disabled = false;
        elements.refreshBtn.textContent = "刷新";
      }
    });
  }

  if (elements.showArchivedToggle) {
    elements.showArchivedToggle.addEventListener("change", () => {
      state.showArchived = elements.showArchivedToggle.checked;
      renderSessionList();
    });
  }

  if (elements.exportMdBtn) {
    elements.exportMdBtn.addEventListener("click", () => {
      if (state.currentDetail) exportSessionMarkdown(state.currentDetail);
    });
  }

  if (elements.exportJsonBtn) {
    elements.exportJsonBtn.addEventListener("click", () => {
      if (state.currentDetail) exportSessionJson(state.currentDetail);
    });
  }

  let searchDebounce = null;
  elements.searchInput.addEventListener("input", (event) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
      state.searchQuery = event.target.value.trim();
      syncUrl();
      await loadSessions();
    }, 300);
  });

  elements.tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.tab;
      updateTabs();
    });
    button.addEventListener("keydown", (e) => {
      const tabs = elements.tabButtons;
      const idx = tabs.indexOf(button);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const next = e.key === "ArrowRight" ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
        tabs[next].focus();
        tabs[next].click();
      }
    });
  });

  elements.sessionList.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(elements.sessionList.querySelectorAll(".session-item"));
    if (!items.length) return;
    const focused = document.activeElement;
    const idx = items.indexOf(focused);
    let next;
    if (e.key === "ArrowDown") {
      next = idx < items.length - 1 ? idx + 1 : 0;
    } else {
      next = idx > 0 ? idx - 1 : items.length - 1;
    }
    items[next].focus();
    const sid = items[next].dataset.sessionId;
    if (sid) selectSession(sid, items[next]);
  });

  await loadSessions();

  const eventSource = new EventSource("/api/events");
  eventSource.addEventListener("session-added", (e) => {
    try {
      const summary = JSON.parse(e.data);
      if (!state.sessions.find((s) => s.id === summary.id)) {
        state.sessions.push(summary);
        const loadMoreBtn = elements.sessionList.querySelector(".load-more-btn");
        if (loadMoreBtn) loadMoreBtn.remove();
        appendSessionItems([summary]);
        renderLoadMoreButton();
        const archivedIds = getArchivedIds();
        const visible = state.sessions.filter((s) => state.showArchived || !archivedIds.has(s.id));
        elements.sessionCount.textContent = String(visible.length);

        const ariaLive = document.querySelector("#aria-live");
        if (ariaLive) {
          ariaLive.textContent = `新会话已添加: ${summary.cwd || summary.id}`;
          setTimeout(() => { ariaLive.textContent = ""; }, 3000);
        }
      }
    } catch { /* ignore parse errors */ }
  });
}

initialize().catch((error) => {
  console.error(error);
  elements.sessionList.innerHTML = `<p class="hero-copy">加载失败：${error.message}</p>`;
});
