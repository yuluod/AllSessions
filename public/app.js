import { t, setLang, getLang, updateStaticI18n } from "./i18n.js";

const PAGE_LIMIT = 50;
const ARCHIVE_KEY = "codex_viewer_archived_sessions";

const state = {
  facets: null,
  stats: null,
  sessions: [],
  selectedSessionKey: null,
  activeTab: "conversation",
  hasMore: false,
  nextCursor: null,
  searchQuery: "",
  showArchived: false,
  currentDetail: null,
  filters: {
    provider: "",
    source_kind: "",
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
  sourceKindFilter: document.querySelector("#source-kind-filter"),
  providerFilter: document.querySelector("#provider-filter"),
  dateFilter: document.querySelector("#date-filter"),
  cwdFilter: document.querySelector("#cwd-filter"),
  searchInput: document.querySelector("#search-input"),
  resetFilters: document.querySelector("#reset-filters"),
  refreshBtn: document.querySelector("#refresh-btn"),
  langToggle: document.querySelector("#lang-toggle"),
  showArchivedToggle: document.querySelector("#show-archived-toggle"),
  sessionList: document.querySelector("#session-list"),
  detailEmpty: document.querySelector("#detail-empty"),
  detailView: document.querySelector("#detail-view"),
  detailTitle: document.querySelector("#detail-title"),
  detailTags: document.querySelector("#detail-tags"),
  propsContent: document.querySelector("#props-content"),
  conversationList: document.querySelector("#conversation-list"),
  rawEvents: document.querySelector("#raw-events"),
  conversationTab: document.querySelector("#conversation-tab"),
  rawTab: document.querySelector("#raw-tab"),
  tabButtons: Array.from(document.querySelectorAll(".tab-button")),
  exportMdBtn: document.querySelector("#export-md-btn"),
  exportJsonBtn: document.querySelector("#export-json-btn"),
  statsDashboard: document.querySelector("#stats-dashboard"),
  statsMetrics: document.querySelector("#stats-metrics"),
  statsGrid: document.querySelector("#stats-grid"),
  sessionItemTemplate: document.querySelector("#session-item-template"),
  conversationItemTemplate: document.querySelector("#conversation-item-template"),
  rawEventTemplate: document.querySelector("#raw-event-template")
};

// ── URL 状态同步 ──────────────────────────────────────────────────────────────
function syncUrl() {
  const params = new URLSearchParams();
  if (state.filters.provider) params.set("provider", state.filters.provider);
  if (state.filters.source_kind) params.set("source_kind", state.filters.source_kind);
  if (state.filters.date) params.set("date", state.filters.date);
  if (state.filters.cwd) params.set("cwd", state.filters.cwd);
  if (state.searchQuery) params.set("q", state.searchQuery);
  if (state.selectedSessionKey) params.set("session", state.selectedSessionKey);
  const search = params.toString();
  history.replaceState(null, "", search ? `?${search}` : location.pathname);
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  state.filters.provider = params.get("provider") || "";
  state.filters.source_kind = params.get("source_kind") || "";
  state.filters.date = params.get("date") || "";
  state.filters.cwd = params.get("cwd") || "";
  state.searchQuery = params.get("q") || "";
  state.selectedSessionKey = params.get("session") || null;
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function formatTimestamp(value) {
  if (!value) {
    return t("unknownTime");
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const locale = getLang() === "zh" ? "zh-CN" : "en";

  return new Intl.DateTimeFormat(locale, {
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
  select.append(createOption("", t("all")));
  values.forEach((value) => {
    select.append(createOption(value, value));
  });
  select.value = values.includes(currentValue) ? currentValue : "";
}

function updateFacetFilters() {
  if (!state.facets) {
    return;
  }

  fillSelect(elements.sourceKindFilter, state.facets.source_kinds || []);
  fillSelect(elements.providerFilter, state.facets.providers);
  fillSelect(elements.dateFilter, state.facets.dates);
  fillSelect(elements.cwdFilter, state.facets.cwds);
}

function syncSessionRoot() {
  const roots = state.facets?.session_roots;
  if (!roots || !roots.length) {
    elements.sessionRoot.textContent = t("loading");
    return;
  }
  elements.sessionRoot.textContent = roots.join(", ");
}

function rerenderLocalizedContent() {
  syncSessionRoot();
  updateFacetFilters();
  renderSessionList();
  if (state.currentDetail) {
    const fullCwd = state.currentDetail.summary.cwd || t("noWorkDir");
    elements.detailTitle.textContent = fullCwd.split(/[\\/]/).pop() || fullCwd;
    elements.detailTitle.title = fullCwd;
    renderDetailTags(state.currentDetail.summary);
    renderPropsPanel(state.currentDetail.summary);
    renderConversation(state.currentDetail.conversation_messages);
    renderRawEvents(state.currentDetail.raw_events);
    updateTabs();
  }
  if (state.stats) {
    renderStats(state.stats);
  }
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

function buildSessionsUrl({ cursor } = {}) {
  const query = buildSessionQuery();
  const prefix = query ? `/api/sessions?${query}&` : "/api/sessions?";
  let url = `${prefix}limit=${PAGE_LIMIT}`;
  if (cursor) url += `&cursor=${cursor}`;
  return url;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(errorBody || t("requestFailed", { status: response.status }));
  }
  return response.json();
}

function appendSessionItems(sessions) {
  const archivedIds = getArchivedIds();
  sessions.forEach((session) => {
    const archived = archivedIds.has(session._key);
    if (archived && !state.showArchived) return;

    const fragment = elements.sessionItemTemplate.content.cloneNode(true);
    const button = fragment.querySelector(".session-item");
    button.dataset.sessionKey = session._key;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", session._key === state.selectedSessionKey ? "true" : "false");
    button.querySelector(".session-time").textContent = formatTimestamp(
      session.timestamp || session.last_timestamp
    );
    button.querySelector(".session-provider").textContent = session.model_provider || "unknown";
    button.querySelector(".session-cwd").textContent = session.cwd || t("noCwd");
    button.querySelector(".session-events").textContent = t("eventsCount", { n: session.event_count });
    button.querySelector(".session-source").textContent = session.source || session.originator || t("unknownSource");
    button.querySelector(".session-source-kind").textContent = session.display_source || session.source_kind || "";
    if (session._key === state.selectedSessionKey) {
      button.classList.add("active");
    }
    if (archived) {
      button.classList.add("archived");
    }

    const archiveBtn = document.createElement("button");
    archiveBtn.className = "session-archive-btn";
    archiveBtn.title = archived ? t("unarchive") : t("archive");
    archiveBtn.textContent = archived ? "↩" : "⊗";
    archiveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleArchive(session._key);
      renderSessionList();
    });
    button.append(archiveBtn);

    button.addEventListener("click", () => {
      selectSession(session._key, button);
    });
    elements.sessionList.append(fragment);
  });
}

function selectSession(key, buttonEl) {
  state.selectedSessionKey = key;
  elements.sessionList.querySelectorAll(".session-item").forEach((el) => {
    el.classList.remove("active");
    el.setAttribute("aria-selected", "false");
  });
  if (buttonEl) {
    buttonEl.classList.add("active");
    buttonEl.setAttribute("aria-selected", "true");
  }
  syncUrl();
  loadSessionDetail(key);
}

function renderLoadMoreButton() {
  let btn = elements.sessionList.querySelector(".load-more-btn");
  if (btn) btn.remove();

  if (!state.hasMore) return;

  btn = document.createElement("button");
  btn.className = "ghost-button load-more-btn";
  btn.textContent = t("loadMore");
  btn.addEventListener("click", async () => {
    btn.textContent = t("loadingMore");
    btn.disabled = true;
    await loadMoreSessions();
  });
  elements.sessionList.append(btn);
}

function renderSessionList() {
  elements.sessionList.innerHTML = "";

  const archivedIds = getArchivedIds();
  const visible = state.sessions.filter((s) => state.showArchived || !archivedIds.has(s._key));

  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "hero-copy";
    empty.textContent = t("noResults");
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
    `# ${t("session")}: ${summary.cwd || summary.id}`,
    ``,
    `- **${t("startTime")}**: ${formatTimestamp(summary.timestamp)}`,
    `- **Provider**: ${summary.model_provider || "unknown"}`,
    `- **${t("source")}**: ${summary.source || summary.originator || "-"}`,
    `- **${t("sessionId")}**: ${summary.id}`,
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

// ── 详情标签行 ──────────────────────────────────────────────────────────────────
function renderDetailTags(summary) {
  elements.detailTags.innerHTML = "";
  const tags = [
    { text: formatTimestamp(summary.timestamp), icon: "calendar" },
    { text: summary.model_provider || "unknown", cls: "tag-provider" },
    { text: summary.display_source || summary.source_kind || "", cls: "tag-source" },
    { text: summary.source || summary.originator || "", cls: "" },
    { text: t("eventsCount", { n: summary.event_count }), icon: "hash" }
  ];

  tags.forEach(({ text, cls, icon }) => {
    if (!text) return;
    const span = document.createElement("span");
    span.className = `detail-tag ${cls || ""}`.trim();
    if (icon === "calendar") {
      span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> ${text}`;
    } else if (icon === "hash") {
      span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg> ${text}`;
    } else {
      span.textContent = text;
    }
    elements.detailTags.append(span);
  });
}

// ── 属性面板 ────────────────────────────────────────────────────────────────────
function renderPropsPanel(summary) {
  const basic = [
    { label: "Provider", value: summary.model_provider || "unknown" },
    { label: t("source"), value: summary.display_source || summary.source_kind || "-" }
  ];
  const tech = [
    { label: t("sessionId"), value: summary.id, copyable: true },
    { label: t("filePath"), value: summary.file_path, copyable: true },
    { label: t("cwdLabel"), value: summary.cwd || "-", copyable: true }
  ];

  function section(title, rows) {
    const wrap = document.createElement("div");
    wrap.className = "props-section";
    const h3 = document.createElement("h3");
    h3.textContent = title;
    wrap.append(h3);
    const dl = document.createElement("dl");
    rows.forEach(({ label, value, copyable }) => {
      const row = document.createElement("div");
      row.className = "prop-row";
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      const valSpan = document.createElement("span");
      valSpan.className = "prop-value";
      valSpan.textContent = value || "-";
      valSpan.title = value || "";
      dd.append(valSpan);
      if (copyable && value) {
        const btn = document.createElement("button");
        btn.className = "prop-copy";
        btn.textContent = "copy";
        btn.addEventListener("click", () => {
          navigator.clipboard.writeText(value).then(() => {
            btn.textContent = "✓";
            setTimeout(() => { btn.textContent = "copy"; }, 1500);
          });
        });
        dd.append(btn);
      }
      row.append(dt, dd);
      dl.append(row);
    });
    wrap.append(dl);
    return wrap;
  }

  elements.propsContent.innerHTML = "";
  elements.propsContent.append(
    section(t("basicInfo"), basic),
    section(t("techInfo"), tech)
  );
}

function renderConversation(messages) {
  elements.conversationList.innerHTML = "";

  if (!messages.length) {
    const empty = document.createElement("p");
    empty.className = "hero-copy";
    empty.textContent = t("noConversations");
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
    copyBtn.title = t("copyMessage");
    copyBtn.textContent = t("copy");
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(message.text).then(() => {
        copyBtn.textContent = "✓";
        setTimeout(() => { copyBtn.textContent = t("copy"); }, 1500);
      }).catch(() => {
        copyBtn.textContent = t("copyFailed");
        setTimeout(() => { copyBtn.textContent = t("copy"); }, 1500);
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
    fragment.querySelector(".raw-event-line").textContent = t("linePrefix", { n: event.line_number });
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
    const fullCwd = detail.summary.cwd || t("noWorkDir");
    elements.detailTitle.textContent = fullCwd.split(/[\\/]/).pop() || fullCwd;
    elements.detailTitle.title = fullCwd;
    renderDetailTags(detail.summary);
    renderPropsPanel(detail.summary);
    renderConversation(detail.conversation_messages);
    renderRawEvents(detail.raw_events);
    updateTabs();
  } catch (error) {
    console.error(error);
    showError(`${t("loadDetailFailed")}: ${error.message}`);
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
      data = await fetchJson(buildSessionsUrl());
      state.sessions = data.sessions;
      state.hasMore = data.has_more;
      state.nextCursor = data.next_cursor;
    }
    state.facets = { ...state.facets, session_roots: data.session_roots };
    syncSessionRoot();

    if (state.selectedSessionKey && !state.sessions.find((session) => session._key === state.selectedSessionKey)) {
      state.selectedSessionKey = null;
    }

    renderSessionList();

    if (!state._initialized && !state.selectedSessionKey && state.sessions[0]) {
      const archivedIds = getArchivedIds();
      const first = state.sessions.find((s) => !archivedIds.has(s._key)) || state.sessions[0];
      state.selectedSessionKey = first._key;
    }

    if (state.selectedSessionKey) {
      elements.sessionList.querySelectorAll(".session-item").forEach((el) => {
        el.classList.toggle("active", el.dataset.sessionKey === state.selectedSessionKey);
      });
      await loadSessionDetail(state.selectedSessionKey);
    } else {
      elements.detailView.classList.add("hidden");
      elements.detailEmpty.classList.remove("hidden");
    }
    if (state._initialized) syncUrl();
  } catch (error) {
    console.error(error);
    showError(`${t("loadListFailed")}: ${error.message}`);
  }
}

async function loadMoreSessions() {
  try {
    const data = await fetchJson(buildSessionsUrl({ cursor: state.nextCursor }));
    state.sessions = state.sessions.concat(data.sessions);
    state.hasMore = data.has_more;
    state.nextCursor = data.next_cursor;

    const loadMoreBtn = elements.sessionList.querySelector(".load-more-btn");
    if (loadMoreBtn) loadMoreBtn.remove();

    appendSessionItems(data.sessions);
    renderLoadMoreButton();
    const archivedIds = getArchivedIds();
    const visible = state.sessions.filter((s) => state.showArchived || !archivedIds.has(s._key));
    elements.sessionCount.textContent = String(visible.length);
  } catch (error) {
    console.error(error);
    showError(`${t("loadMoreFailed")}: ${error.message}`);
  }
}

// ── 统计面板 ──────────────────────────────────────────────────────────────────
function renderBar(label, count, max, displayLabel = label) {
  const row = document.createElement("div");
  row.className = "stats-bar-row";
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  const labelEl = document.createElement("span");
  labelEl.className = "stats-bar-label";
  labelEl.title = label;
  labelEl.textContent = displayLabel;
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
  const dashboard = elements.statsDashboard;
  if (!dashboard) return;

  // metrics: compute from backend fields, fallback to by_date/by_provider sums for compatibility
  const metrics = elements.statsMetrics;
  if (metrics) {
    metrics.innerHTML = "";
    const byDate = stats.by_date || [];
    const total = stats.total ?? byDate.reduce((s, d) => s + (d.count || 0), 0);
    const activeDays = stats.active_days ?? byDate.length;
    const avg = stats.avg_daily ?? (activeDays > 0 ? (total / activeDays).toFixed(1) : "0");
    const cards = [
      { label: t("statsTotalSessions"), value: String(total) },
      { label: t("statsActiveDays"), value: String(activeDays) },
      { label: t("statsAvgDaily"), value: String(avg) },
      { label: t("statsEvents"), value: "—" }
    ];
    cards.forEach(({ label, value }, idx) => {
      const card = document.createElement("div");
      card.className = "metric-card";
      card.dataset.metricIdx = String(idx);
      const val = document.createElement("div");
      val.className = "metric-value";
      val.textContent = value;
      const lbl = document.createElement("div");
      lbl.className = "metric-label";
      lbl.textContent = label;
      const spark = document.createElement("div");
      spark.className = "metric-spark";
      const sparkInner = document.createElement("div");
      sparkInner.className = "metric-spark-bar";
      const dates = stats.by_date || [];
      sparkInner.style.width = dates.length
        ? `${Math.min(100, (dates.reduce((s, d) => s + d.count, 0) / (dates.length * 10)) * 100)}%`
        : "0%";
      spark.append(sparkInner);
      card.append(val, lbl, spark);
      metrics.append(card);
    });
  }

  // trend chart
  const trendBody = document.querySelector("#trend-chart-body");
  if (trendBody) {
    trendBody.innerHTML = "";
    const dates = (stats.by_date || []).slice(-14);
    if (dates.length) {
      const max = Math.max(...dates.map((d) => d.count), 1);
      const wrap = document.createElement("div");
      wrap.className = "trend-bars";
      dates.forEach(({ label, count }) => {
        const col = document.createElement("div");
        col.className = "trend-col";

        const val = document.createElement("span");
        val.className = "trend-val";
        val.textContent = String(count);

        const barWrap = document.createElement("div");
        barWrap.className = "trend-bar-wrap";
        const bar = document.createElement("div");
        bar.className = "trend-bar";
        bar.style.height = `${(count / max) * 100}%`;
        bar.title = `${label}: ${count}`;
        barWrap.append(bar);

        const date = document.createElement("span");
        date.className = "trend-date";
        date.textContent = label.slice(5);

        col.append(val, barWrap, date);
        wrap.append(col);
      });
      trendBody.append(wrap);
    } else {
      trendBody.innerHTML = '<div style="text-align:center;color:var(--muted);padding:60px 0;">—</div>';
    }
  }

  // donut chart
  const donutBody = document.querySelector("#donut-chart-body");
  if (donutBody) {
    donutBody.innerHTML = "";
    const items = (stats.by_provider || []).slice(0, 6);
    if (items.length) {
      const total = items.reduce((s, i) => s + i.count, 0);
      const colors = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];
      let acc = 0;
      const stops = items.map((item, idx) => {
        const pct = (item.count / total) * 100;
        const start = acc;
        acc += pct;
        return `${colors[idx % colors.length]} ${start.toFixed(2)}% ${acc.toFixed(2)}%`;
      });
      const wrap = document.createElement("div");
      wrap.className = "donut-wrap";

      const donut = document.createElement("div");
      donut.className = "donut-chart";
      donut.style.background = `conic-gradient(${stops.join(", ")})`;
      donut.style.mask = "radial-gradient(transparent 55%, black 56%)";
      donut.style.webkitMask = "radial-gradient(transparent 55%, black 56%)";

      const legend = document.createElement("div");
      legend.className = "donut-legend";
      items.forEach((item, idx) => {
        const row = document.createElement("div");
        row.className = "donut-legend-item";
        const dot = document.createElement("span");
        dot.className = "donut-dot";
        dot.style.background = colors[idx % colors.length];
        const name = document.createElement("span");
        name.textContent = item.label;
        const count = document.createElement("span");
        count.textContent = String(item.count);
        count.style.textAlign = "right";
        const pct = document.createElement("span");
        pct.className = "donut-pct";
        pct.textContent = `${((item.count / total) * 100).toFixed(1)}%`;
        row.append(dot, name, count, pct);
        legend.append(row);
      });

      wrap.append(donut, legend);
      donutBody.append(wrap);
    } else {
      donutBody.innerHTML = '<div style="text-align:center;color:var(--muted);padding:60px 0;">—</div>';
    }
  }

  // grid charts
  const grid = elements.statsGrid;
  if (grid) {
    grid.innerHTML = "";
    const sections = [
      { title: t("statsRecentDaily"), items: (stats.by_date || []).slice(0, 14) },
      { title: t("statsCommonSourceKind"), items: stats.by_source_kind || [] },
      { title: t("statsCommonProvider"), items: stats.by_provider || [] },
      { title: t("statsCommonCwd"), items: (stats.by_cwd || []).slice(0, 8), isPath: true }
    ];
    sections.forEach(({ title, items, isPath }) => {
      if (!items.length) return;
      const section = document.createElement("div");
      section.className = "stats-section";
      const h = document.createElement("h3");
      h.textContent = title;
      section.append(h);
      const max = Math.max(...items.map((i) => i.count));
      items.forEach(({ label, count }) => {
        if (isPath) {
          const basename = label.split("/").pop() || label;
          section.append(renderBar(label, count, max, basename));
        } else {
          section.append(renderBar(label, count, max));
        }
      });
      grid.append(section);
    });
  }

  // right panel: render filter summary card
  const propsContent = elements.propsContent;
  if (propsContent) {
    propsContent.innerHTML = "";
    const card = document.createElement("div");
    card.className = "stats-filter-summary";
    const h = document.createElement("h4");
    h.textContent = "当前筛选";
    card.append(h);
    const makeRow = (label, value) => {
      const row = document.createElement("div");
      row.className = "filter-summary-row";
      const lbl = document.createElement("span");
      lbl.textContent = label;
      const val = document.createElement("strong");
      val.textContent = value || "全部";
      row.append(lbl, val);
      return row;
    };
    card.append(
      makeRow("来源", state.filters.source_kind),
      makeRow("Provider", state.filters.provider),
      makeRow("日期", state.filters.date),
      makeRow("目录", state.filters.cwd)
    );
    propsContent.append(card);
  }
}

async function loadStats() {
  try {
    const params = buildSessionQuery();
    const url = `/api/stats${params ? "?" + params : ""}`;
    const stats = await fetchJson(url);
    state.stats = stats;
    renderStats(stats);
  } catch { /* silently ignore stats loading errors */ }
}

async function initialize() {
  restoreFromUrl();

  state.facets = await fetchJson("/api/facets");
  syncSessionRoot();
  updateFacetFilters();

  if (state.filters.source_kind) elements.sourceKindFilter.value = state.filters.source_kind;
  if (state.filters.provider) elements.providerFilter.value = state.filters.provider;
  if (state.filters.date) elements.dateFilter.value = state.filters.date;
  if (state.filters.cwd) elements.cwdFilter.value = state.filters.cwd;
  if (state.searchQuery) elements.searchInput.value = state.searchQuery;

  await loadStats();

  elements.sourceKindFilter.addEventListener("change", async (event) => {
    state.filters.source_kind = event.target.value;
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  elements.providerFilter.addEventListener("change", async (event) => {
    state.filters.provider = event.target.value;
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  elements.dateFilter.addEventListener("change", async (event) => {
    state.filters.date = event.target.value;
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  elements.cwdFilter.addEventListener("change", async (event) => {
    state.filters.cwd = event.target.value;
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  elements.resetFilters.addEventListener("click", async () => {
    state.filters = { provider: "", source_kind: "", date: "", cwd: "" };
    state.searchQuery = "";
    elements.sourceKindFilter.value = "";
    elements.providerFilter.value = "";
    elements.dateFilter.value = "";
    elements.cwdFilter.value = "";
    elements.searchInput.value = "";
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  if (elements.refreshBtn) {
    elements.refreshBtn.addEventListener("click", async () => {
      elements.refreshBtn.disabled = true;
      elements.refreshBtn.textContent = t("refreshing");
      try {
        await fetchJson("/api/refresh");
        await Promise.all([loadSessions(), loadStats()]);
      } catch (error) {
        showError(`${t("refreshFailed")}: ${error.message}`);
      } finally {
        elements.refreshBtn.disabled = false;
        elements.refreshBtn.textContent = t("refresh");
      }
    });
  }

  if (elements.showArchivedToggle) {
    elements.showArchivedToggle.addEventListener("change", () => {
      state.showArchived = elements.showArchivedToggle.checked;
      renderSessionList();
    });
  }

  document.querySelectorAll(".sidebar-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const panel = tab.dataset.sidebarTab;
      document.querySelectorAll(".sidebar-tab").forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", t === tab ? "true" : "false");
      });
      document.querySelectorAll(".sidebar-body").forEach((p) => {
        p.classList.toggle("hidden", p.dataset.sidebarPanel !== panel);
      });

      const detailPanel = document.querySelector("#detail-panel");
      const propsPanel = document.querySelector("#props-panel");
      const statsDashboard = document.querySelector("#stats-dashboard");
      const propsEyebrow = document.querySelector("#props-eyebrow");
      if (panel === "stats") {
        if (detailPanel) detailPanel.classList.add("hidden");
        if (statsDashboard) statsDashboard.classList.remove("hidden");
        if (propsEyebrow) propsEyebrow.textContent = "当前筛选";
      } else {
        if (detailPanel) detailPanel.classList.remove("hidden");
        if (propsPanel) propsPanel.classList.remove("hidden");
        if (statsDashboard) statsDashboard.classList.add("hidden");
        if (propsEyebrow) propsEyebrow.textContent = "PROPERTIES";
        // clear stats filter summary from props panel
        const pc = document.querySelector("#props-content");
        if (pc && pc.querySelector(".stats-filter-summary")) pc.innerHTML = "";
      }
    });
  });

  const filterToggle = document.querySelector("#filter-toggle");
  if (filterToggle) {
    filterToggle.addEventListener("click", () => {
      const tab = document.querySelector('.sidebar-tab[data-sidebar-tab="stats"]');
      if (tab && !tab.classList.contains("active")) tab.click();
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
    const skey = items[next].dataset.sessionKey;
    if (skey) selectSession(skey, items[next]);
  });

  updateStaticI18n();
  document.documentElement.lang = getLang() === "zh" ? "zh-CN" : "en";

  if (elements.langToggle) {
    elements.langToggle.addEventListener("click", () => {
      const next = getLang() === "zh" ? "en" : "zh";
      setLang(next);
      rerenderLocalizedContent();
    });
  }

  await loadSessions();
  state._initialized = true;

  const eventSource = new EventSource("/api/events");
  eventSource.addEventListener("session-added", (e) => {
    try {
      const summary = JSON.parse(e.data);
      const key = summary._key;
      if (!key) return;
      if (!state.sessions.find((s) => s._key === key)) {
        state.sessions.push(summary);
        state.sessions.sort((a, b) => {
          const ta = a.timestamp || a.last_timestamp || "";
          const tb = b.timestamp || b.last_timestamp || "";
          return tb.localeCompare(ta);
        });
        renderSessionList();
        const archivedIds = getArchivedIds();
        const visible = state.sessions.filter((s) => state.showArchived || !archivedIds.has(s._key));
        elements.sessionCount.textContent = String(visible.length);

        const ariaLive = document.querySelector("#aria-live");
        if (ariaLive) {
          ariaLive.textContent = `${t("newSessionAdded")}: ${summary.cwd || summary.id}`;
          setTimeout(() => { ariaLive.textContent = ""; }, 3000);
        }
      }
    } catch { /* ignore parse errors */ }
  });

  eventSource.addEventListener("session-updated", (e) => {
    try {
      const summary = JSON.parse(e.data);
      const key = summary._key;
      if (!key) return;
      const idx = state.sessions.findIndex((s) => s._key === key);
      if (idx >= 0) {
        state.sessions[idx] = summary;
        state.sessions.sort((a, b) => {
          const ta = a.timestamp || a.last_timestamp || "";
          const tb = b.timestamp || b.last_timestamp || "";
          return tb.localeCompare(ta);
        });
      }
      if (state.selectedSessionKey === key) {
        loadSessionDetail(key);
      }
      renderSessionList();
    } catch { /* ignore parse errors */ }
  });

  eventSource.addEventListener("session-deleted", (e) => {
    try {
      const { id } = JSON.parse(e.data);
      const key = id;
      if (!key) return;
      state.sessions = state.sessions.filter((s) => s._key !== key);
      if (state.selectedSessionKey === key) {
        state.selectedSessionKey = null;
        elements.detailView.classList.add("hidden");
        elements.detailEmpty.classList.remove("hidden");
      }
      renderSessionList();
    } catch { /* ignore parse errors */ }
  });
}

initialize().catch((error) => {
  console.error(error);
  elements.sessionList.innerHTML = `<p class="hero-copy">${t("loadListFailed")}: ${error.message}</p>`;
});
