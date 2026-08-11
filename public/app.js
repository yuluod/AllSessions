import { t, setLang, getLang, updateStaticI18n } from "./i18n.js";
import { fetchJson as requestJson, setMutationToken } from "./api-client.js";
import { createLatestRequestGate, isAbortError } from "./async-coordinator.js";
import { bindSessionEvents } from "./session-events.js";

const PAGE_LIMIT = 50;
const PROJECT_PREVIEW_LIMIT = 4;
const MOBILE_LAYOUT_QUERY = "(max-width: 760px)";
const ARCHIVE_KEY = "codex_viewer_archived_sessions";
const sessionRequestGate = createLatestRequestGate();
const detailRequestGate = createLatestRequestGate();
const statsRequestGate = createLatestRequestGate();
const codexMigrationPreviewRequestGate = createLatestRequestGate();

const state = {
  capabilities: null,
  facets: null,
  stats: null,
  sessions: [],
  selectedSessionKey: null,
  activeTab: "conversation",
  hasMore: false,
  nextCursor: null,
  searchQuery: "",
  showArchived: false,
  showCodexArchived: false,
  showHidden: false,
  showAllProjects: false,
  codexMigrationPreview: null,
  codexMigrationSelectedProviders: new Set(),
  currentDetail: null,
  detailQuery: "",
  showTools: true,
  showContext: false,
  activeView: "list",
  filters: {
    provider: "",
    source_kind: "",
    date: "",
    cwd: ""
  },
  roleFilter: ""
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

function isCodexArchivedSession(session) {
  return session?.archived === true && session.archive_source === "codex";
}

function scrollToWorkspaceSection(element) {
  if (!element) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "start"
  });
}

function isHiddenSession(session) {
  return session?.hidden === true;
}

function hiddenReasonLabel(session) {
  if (!isHiddenSession(session)) {
    return "";
  }
  if (session.hidden_reason === "subagent") {
    return t("hiddenSubagent");
  }
  return session.hidden_reason || t("hiddenSession");
}

function visibilityLabel(session) {
  if (isCodexArchivedSession(session)) {
    return t("codexArchived");
  }
  return hiddenReasonLabel(session) || t("visibleSession");
}

const elements = {
  appLayout: document.querySelector(".app-layout"),
  sidebarLeft: document.querySelector(".sidebar-left"),
  sidebarFilters: document.querySelector("#sidebar-filters"),
  projectNav: document.querySelector(".project-nav"),
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
  showCodexArchivedToggle: document.querySelector("#show-codex-archived-toggle"),
  showHiddenToggle: document.querySelector("#show-hidden-toggle"),
  projectList: document.querySelector("#project-list"),
  activeFilterBar: document.querySelector("#active-filter-bar"),
  sessionList: document.querySelector("#session-list"),
  detailEmpty: document.querySelector("#detail-empty"),
  detailView: document.querySelector("#detail-view"),
  detailTitle: document.querySelector("#detail-title"),
  detailTags: document.querySelector("#detail-tags"),
  propsContent: document.querySelector("#props-content"),
  detailSearchInput: document.querySelector("#detail-search-input"),
  showToolsToggle: document.querySelector("#show-tools-toggle"),
  showContextToggle: document.querySelector("#show-context-toggle"),
  messageNavInlineList: document.querySelector("#message-nav-inline-list"),
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
  toolsDashboard: document.querySelector("#tools-dashboard"),
  codexMigrationCard: document.querySelector("#codex-migration-card"),
  codexMaintenanceToggle: document.querySelector("#codex-maintenance-toggle"),
  codexMigrationPreviewBtn: document.querySelector("#codex-migration-preview-btn"),
  codexMigrationApplyBtn: document.querySelector("#codex-migration-apply-btn"),
  codexMigrationRollbackBtn: document.querySelector("#codex-migration-rollback-btn"),
  codexMigrationConfirm: document.querySelector("#codex-migration-confirm"),
  codexMigrationStatus: document.querySelector("#codex-migration-status"),
  codexMigrationThreadCount: document.querySelector("#codex-migration-thread-count"),
  codexMigrationJsonlCount: document.querySelector("#codex-migration-jsonl-count"),
  codexMigrationReplacementCount: document.querySelector("#codex-migration-replacement-count"),
  codexMigrationDiagnostics: document.querySelector("#codex-migration-diagnostics"),
  codexMigrationCurrentProvider: document.querySelector("#codex-migration-current-provider"),
  codexMigrationTargetProvider: document.querySelector("#codex-migration-target-provider"),
  codexMigrationDiagnosticList: document.querySelector("#codex-migration-diagnostic-list"),
  codexMigrationProviderList: document.querySelector("#codex-migration-provider-list"),
  codexMigrationRollbackDir: document.querySelector("#codex-migration-rollback-dir"),
  codexMigrationBackupNotice: document.querySelector("#codex-migration-backup-notice"),
  codexMigrationBackupLabel: document.querySelector("#codex-migration-backup-label"),
  codexMigrationBackupPath: document.querySelector("#codex-migration-backup-path"),
  openCodexArchiveBtn: document.querySelector("#open-codex-archive-btn"),
  mobileBackBtn: document.querySelector("#mobile-back-btn"),
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
  if (state.showCodexArchived) params.set("show_codex_archived", "1");
  if (state.showHidden) params.set("show_hidden", "1");
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
  state.showCodexArchived = params.get("show_codex_archived") === "1" ||
    params.get("show_codex_archived") === "true";
  state.showHidden = params.get("show_hidden") === "1" ||
    params.get("show_hidden") === "true";
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
    timeStyle: "medium"
  }).format(date);
}

function sessionTimestamp(session) {
  return session.timestamp || session.last_timestamp || "";
}

function dateKeyFromValue(value) {
  if (typeof value !== "string" || value.length < 10) {
    return "";
  }
  return value.slice(0, 10);
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateGroup(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return { key: "unknown", label: t("unknownTime") };
  }

  const key = dateKeyFromValue(value) || localDateKey(date);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (key === localDateKey(today)) {
    return { key, label: t("today") };
  }
  if (key === localDateKey(yesterday)) {
    return { key, label: t("yesterday") };
  }

  const locale = getLang() === "zh" ? "zh-CN" : "en";
  return {
    key,
    label: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date)
  };
}

function cwdParts(cwd) {
  if (!cwd) {
    return { main: t("noCwd"), path: "" };
  }
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  const main = parts.at(-1) || cwd;
  return { main, path: cwd };
}

function displaySourceLabel(summary) {
  if (isCodexArchivedSession(summary)) {
    return t("codexArchived");
  }
  return summary.display_source || summary.source_kind || "";
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

async function setCwdFilter(cwd) {
  state.filters.cwd = cwd;
  syncFilterControls();
  syncUrl();
  await Promise.all([loadSessions(), loadStats()]);
}

function renderProjectNav() {
  if (!elements.projectList) return;

  const projects = state.facets?.projects || [];
  elements.projectList.innerHTML = "";

  const allButton = document.createElement("button");
  allButton.className = "project-item";
  allButton.type = "button";
  allButton.classList.toggle("active", !state.filters.cwd);
  const allName = document.createElement("span");
  allName.className = "project-name";
  allName.textContent = t("allProjects");
  const allMeta = document.createElement("span");
  allMeta.className = "project-meta";
  allMeta.textContent = t("projectCount", { n: projects.length });
  allButton.append(allName, allMeta);
  allButton.addEventListener("click", () => {
    setCwdFilter("").catch((error) => {
      console.error(error);
      showError(`${t("loadListFailed")}: ${error.message}`);
    });
  });
  elements.projectList.append(allButton);

  const visibleProjects = state.showAllProjects ? projects : projects.slice(0, PROJECT_PREVIEW_LIMIT);
  visibleProjects.forEach((project) => {
    const button = document.createElement("button");
    button.className = "project-item";
    button.type = "button";
    button.classList.toggle("active", state.filters.cwd === project.path);
    button.title = project.path;

    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = project.name || project.path;

    const meta = document.createElement("span");
    meta.className = "project-meta";
    meta.textContent = t("projectSessionCount", { n: project.count });

    const pathEl = document.createElement("span");
    pathEl.className = "project-path";
    pathEl.textContent = project.path;

    button.append(name, meta, pathEl);
    button.addEventListener("click", () => {
      setCwdFilter(project.path).catch((error) => {
        console.error(error);
        showError(`${t("loadListFailed")}: ${error.message}`);
      });
    });
    elements.projectList.append(button);
  });

  if (projects.length > PROJECT_PREVIEW_LIMIT) {
    const moreButton = document.createElement("button");
    moreButton.className = "project-item project-more";
    moreButton.type = "button";
    moreButton.textContent = state.showAllProjects
      ? t("showFewerProjects")
      : t("showMoreProjects", { n: projects.length - PROJECT_PREVIEW_LIMIT });
    moreButton.addEventListener("click", () => {
      state.showAllProjects = !state.showAllProjects;
      renderProjectNav();
    });
    elements.projectList.append(moreButton);
  }
}

function updateFacetFilters() {
  if (!state.facets) {
    return;
  }

  fillSelect(elements.sourceKindFilter, state.facets.source_kinds || []);
  fillSelect(elements.providerFilter, state.facets.providers);
  fillSelect(elements.dateFilter, state.facets.dates);
  fillSelect(elements.cwdFilter, state.facets.cwds);
  renderProjectNav();
}

function syncSessionRoot() {
  const roots = state.facets?.session_roots;
  if (!roots || !roots.length) {
    elements.sessionRoot.textContent = t("loading");
    elements.sessionRoot.removeAttribute("title");
    return;
  }
  elements.sessionRoot.textContent = t("localSourcesCount", { n: roots.length });
  elements.sessionRoot.title = roots.join("\n");
}

function updateSessionCount() {
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

function syncFilterControls() {
  if (elements.sourceKindFilter) elements.sourceKindFilter.value = state.filters.source_kind;
  if (elements.providerFilter) elements.providerFilter.value = state.filters.provider;
  if (elements.dateFilter) elements.dateFilter.value = state.filters.date;
  if (elements.cwdFilter) elements.cwdFilter.value = state.filters.cwd;
  if (elements.searchInput) elements.searchInput.value = state.searchQuery;
  if (elements.showArchivedToggle) elements.showArchivedToggle.checked = state.showArchived;
  if (elements.showCodexArchivedToggle) {
    elements.showCodexArchivedToggle.checked = state.showCodexArchived;
  }
  if (elements.showHiddenToggle) {
    elements.showHiddenToggle.checked = state.showHidden;
  }
  renderProjectNav();
}

function rerenderLocalizedContent() {
  syncSessionRoot();
  updateFacetFilters();
  syncFilterControls();
  renderSessionList();
  if (state.currentDetail) {
    const fullCwd = state.currentDetail.summary.cwd || t("noWorkDir");
    elements.detailTitle.textContent =
      state.currentDetail.summary.title || fullCwd.split(/[\\/]/).pop() || fullCwd;
    elements.detailTitle.title = fullCwd;
    renderDetailTags(state.currentDetail.summary);
    renderPropsPanel(state.currentDetail.summary, state.currentDetail.conversation_messages);
    renderConversation(state.currentDetail.conversation_messages);
    renderRawEvents(state.currentDetail.raw_events);
    updateTabs();
  } else {
    setDetailPlaceholder(t("selectSession"), t("selectSessionDesc"));
  }
  if (state.stats) {
    renderStats(state.stats);
  }
  if (state.codexMigrationPreview) {
    renderCodexMigrationPreview(state.codexMigrationPreview);
  } else {
    resetCodexMigrationMetrics();
  }
  configureCodexMaintenanceUi();
}

function buildSessionQuery() {
  const params = new URLSearchParams();
  Object.entries(state.filters).forEach(([key, value]) => {
    if (value) {
      params.set(key, value);
    }
  });
  if (state.showCodexArchived) {
    params.set("show_codex_archived", "true");
  }
  if (state.showHidden) {
    params.set("show_hidden", "true");
  }
  return params.toString();
}

function buildSessionsUrl({ cursor } = {}) {
  const query = buildSessionQuery();
  const prefix = query ? `/api/sessions?${query}&` : "/api/sessions?";
  let url = `${prefix}limit=${PAGE_LIMIT}`;
  if (cursor) url += `&cursor=${cursor}`;
  return url;
}

function buildSearchUrl({ cursor } = {}) {
  const params = new URLSearchParams(buildSessionQuery());
  params.set("q", state.searchQuery);
  params.set("limit", String(PAGE_LIMIT));
  if (cursor) params.set("cursor", cursor);
  return `/api/search?${params.toString()}`;
}

async function fetchJson(url, options) {
  return requestJson(url, options, {
    formatError: (status) => t("requestFailed", { status })
  });
}

function visibleSessions() {
  const archivedIds = getArchivedIds();
  return state.sessions.filter((session) => state.showArchived || !archivedIds.has(session._key));
}

async function clearFilterChip(type) {
  if (type in state.filters) {
    state.filters[type] = "";
  } else if (type === "search") {
    state.searchQuery = "";
  } else if (type === "showArchived") {
    state.showArchived = false;
    syncFilterControls();
    renderSessionList();
    return;
  } else if (type === "showCodexArchived") {
    state.showCodexArchived = false;
  } else if (type === "showHidden") {
    state.showHidden = false;
  }

  syncFilterControls();
  syncUrl();

  if (type === "search") {
    await loadSessions();
  } else {
    await Promise.all([loadSessions(), loadStats()]);
  }
}

function activeFilterEntries() {
  const entries = [];
  if (state.searchQuery) {
    entries.push({ type: "search", label: t("filterSearch"), value: state.searchQuery });
  }
  if (state.filters.source_kind) {
    entries.push({ type: "source_kind", label: t("sourceKind"), value: state.filters.source_kind });
  }
  if (state.filters.provider) {
    entries.push({ type: "provider", label: t("provider"), value: state.filters.provider });
  }
  if (state.filters.date) {
    entries.push({ type: "date", label: t("date"), value: state.filters.date });
  }
  if (state.filters.cwd) {
    const { main } = cwdParts(state.filters.cwd);
    entries.push({ type: "cwd", label: t("cwd"), value: main, title: state.filters.cwd });
  }
  if (state.showArchived) {
    entries.push({ type: "showArchived", label: t("showArchived"), value: t("filterEnabled") });
  }
  if (state.showCodexArchived) {
    entries.push({ type: "showCodexArchived", label: t("showCodexArchived"), value: t("filterEnabled") });
  }
  if (state.showHidden) {
    entries.push({ type: "showHidden", label: t("showHidden"), value: t("filterEnabled") });
  }
  return entries;
}

function renderActiveFilters() {
  if (!elements.activeFilterBar) return;

  const entries = activeFilterEntries();
  elements.activeFilterBar.innerHTML = "";
  if (!entries.length) {
    return;
  }

  const label = document.createElement("span");
  label.className = "active-filter-label";
  label.textContent = t("activeFilters");
  elements.activeFilterBar.append(label);

  entries.forEach((entry) => {
    const button = document.createElement("button");
    button.className = "filter-chip";
    button.type = "button";
    const clearLabel = t("clearFilter", { label: `${entry.label}: ${entry.value}` });
    button.title = entry.title ? `${clearLabel} (${entry.title})` : clearLabel;
    button.setAttribute("aria-label", clearLabel);

    const labelSpan = document.createElement("span");
    labelSpan.className = "filter-chip-label";
    labelSpan.textContent = entry.label;

    const valueSpan = document.createElement("span");
    valueSpan.className = "filter-chip-value";
    valueSpan.textContent = entry.value;

    const closeSpan = document.createElement("span");
    closeSpan.className = "filter-chip-close";
    closeSpan.textContent = "×";

    button.append(labelSpan, valueSpan, closeSpan);
    button.addEventListener("click", () => {
      clearFilterChip(entry.type).catch((error) => {
        console.error(error);
        showError(`${t("loadListFailed")}: ${error.message}`);
      });
    });
    elements.activeFilterBar.append(button);
  });
}

function appendSessionGroupHeader(label, count) {
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

function appendSessionItems(sessions) {
  const archivedIds = getArchivedIds();
  sessions.forEach((session) => {
    const archived = archivedIds.has(session._key);

    const fragment = elements.sessionItemTemplate.content.cloneNode(true);
    const row = fragment.querySelector(".session-row");
    const button = fragment.querySelector(".session-item");
    button.dataset.sessionKey = session._key;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", session._key === state.selectedSessionKey ? "true" : "false");
    const title = session.title || cwdParts(session.cwd).main || session.id;
    const preview = session.search_snippet
      ? `${t("searchMatch")}: ${session.search_snippet}`
      : session.preview_text || "";
    const titleEl = button.querySelector(".session-title");
    titleEl.textContent = title;
    titleEl.title = title;
    button.querySelector(".session-time").textContent = formatTimestamp(sessionTimestamp(session));
    button.querySelector(".session-provider").textContent = session.model_provider || "unknown";
    const pathParts = cwdParts(session.cwd);
    const cwdMain = button.querySelector(".session-cwd-main");
    const cwdPath = button.querySelector(".session-cwd-path");
    cwdMain.textContent = pathParts.main;
    cwdMain.title = session.cwd || "";
    if (cwdPath) {
      cwdPath.textContent = pathParts.path;
      cwdPath.title = session.cwd || "";
      cwdPath.classList.toggle("hidden", !pathParts.path);
    }
    const previewEl = button.querySelector(".session-preview");
    previewEl.textContent = preview;
    previewEl.title = preview;
    previewEl.classList.toggle("hidden", !preview);
    button.querySelector(".session-events").textContent = t("eventsCount", { n: session.event_count });
    button.querySelector(".session-messages").textContent = t("messageCount", { n: session.message_count || 0 });
    const toolsEl = button.querySelector(".session-tools");
    toolsEl.textContent = t("toolCount", { n: session.tool_count || 0 });
    toolsEl.classList.toggle("hidden", !session.tool_count);
    button.querySelector(".session-source").textContent = session.source || session.originator || t("unknownSource");
    button.querySelector(".session-source-kind").textContent = displaySourceLabel(session);
    const hiddenReason = hiddenReasonLabel(session);
    if (hiddenReason) {
      const hiddenBadge = document.createElement("span");
      hiddenBadge.className = "session-hidden-reason";
      hiddenBadge.textContent = hiddenReason;
      button.querySelector(".session-tertiary").append(hiddenBadge);
    }
    if (session._key === state.selectedSessionKey) {
      button.classList.add("active");
    }
    if (archived) {
      button.classList.add("archived");
    }

    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "session-archive-btn";
    archiveBtn.title = archived ? t("unarchive") : t("archive");
    archiveBtn.textContent = archived ? "↩" : "⊗";
    archiveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleArchive(session._key);
      renderSessionList();
    });
    row.append(archiveBtn);

    button.addEventListener("click", () => {
      selectSession(session._key, button);
    });
    elements.sessionList.append(fragment);
  });
}

function selectSession(key, buttonEl) {
  state.selectedSessionKey = key;
  state.currentDetail = null;
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
    const loaded = await loadMoreSessions();
    if (!loaded && btn.isConnected) {
      btn.textContent = t("loadMore");
      btn.disabled = false;
    }
  });
  elements.sessionList.append(btn);
}

function renderSessionList() {
  elements.sessionList.innerHTML = "";
  renderActiveFilters();

  const visible = visibleSessions();

  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "hero-copy";
    empty.textContent = t("noResults");
    elements.sessionList.append(empty);
    renderLoadMoreButton();
    updateSessionCount();
    return;
  }

  const groupCounts = new Map();
  visible.forEach((session) => {
    const group = formatDateGroup(sessionTimestamp(session));
    groupCounts.set(group.key, (groupCounts.get(group.key) || 0) + 1);
  });

  let currentGroupKey = "";
  visible.forEach((session) => {
    const group = formatDateGroup(sessionTimestamp(session));
    if (group.key !== currentGroupKey) {
      currentGroupKey = group.key;
      appendSessionGroupHeader(group.label, groupCounts.get(group.key) || 0);
    }
    appendSessionItems([session]);
  });

  renderLoadMoreButton();
  updateSessionCount();
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

function displayMessageText(message) {
  if (message.is_truncation_marker) {
    return t("detailMessagesOmitted", { n: message.omitted_count || 0 });
  }
  if (message.text_truncated) {
    return `${message.text}\n\n${t("detailMessageTextTruncated", {
      n: message.text.length
    })}`;
  }
  return message.text || "";
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
    lines.push(displayMessageText(msg));
    lines.push(``);
  });
  const filename = `session-${summary.id.slice(0, 12)}.md`;
  downloadBlob(lines.join("\n"), filename, "text/markdown; charset=utf-8");
}

function exportSessionJson(detail) {
  const filename = `session-${detail.summary.id.slice(0, 12)}.json`;
  downloadBlob(JSON.stringify(detail, null, 2), filename, "application/json; charset=utf-8");
}

function compactText(value, maxLength = 90) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
}

// ── 详情标签行 ──────────────────────────────────────────────────────────────────
function createTagIcon(icon) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");

  const add = (name, attributes) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
    svg.append(node);
  };

  if (icon === "calendar") {
    add("rect", { x: "3", y: "4", width: "18", height: "18", rx: "2", ry: "2" });
    add("line", { x1: "16", y1: "2", x2: "16", y2: "6" });
    add("line", { x1: "8", y1: "2", x2: "8", y2: "6" });
    add("line", { x1: "3", y1: "10", x2: "21", y2: "10" });
  } else if (icon === "hash") {
    add("line", { x1: "4", y1: "9", x2: "20", y2: "9" });
    add("line", { x1: "4", y1: "15", x2: "20", y2: "15" });
    add("line", { x1: "10", y1: "3", x2: "8", y2: "21" });
    add("line", { x1: "16", y1: "3", x2: "14", y2: "21" });
  }

  return svg;
}

function renderDetailTags(summary) {
  elements.detailTags.innerHTML = "";
  const tags = [
    { text: formatTimestamp(summary.timestamp), icon: "calendar" },
    { text: summary.model_provider || "unknown", cls: "tag-provider" },
    { text: displaySourceLabel(summary), cls: "tag-source" },
    { text: hiddenReasonLabel(summary), cls: "tag-hidden" },
    { text: summary.detail_truncated ? t("partialDetail") : "", cls: "tag-hidden" },
    { text: summary.source || summary.originator || "", cls: "" },
    { text: t("eventsCount", { n: summary.event_count }), icon: "hash" }
  ];

  tags.forEach(({ text, cls, icon }) => {
    if (!text) return;
    const span = document.createElement("span");
    span.className = `detail-tag ${cls || ""}`.trim();
    if (icon) {
      span.append(createTagIcon(icon), document.createTextNode(` ${text}`));
    } else {
      span.append(document.createTextNode(text));
    }
    elements.detailTags.append(span);
  });
}

// ── 属性面板 ────────────────────────────────────────────────────────────────────
function renderPropsPanel(summary, messages = []) {
  const basic = [
    { label: "Provider", value: summary.model_provider || "unknown" },
    { label: t("source"), value: displaySourceLabel(summary) || "-" },
    { label: t("visibility"), value: visibilityLabel(summary) },
    { label: t("messages"), value: String(summary.message_count || 0) },
    { label: t("systemContext"), value: String(summary.context_count || 0) },
    { label: t("toolCalls"), value: String(summary.tool_count || 0) }
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
    section(t("techInfo"), tech),
    createMessageNavSection(messages)
  );
}

function filteredConversationMessages(messages) {
  const query = state.detailQuery.trim().toLowerCase();
  return messages
    .map((message, index) => ({ ...message, _origIdx: index }))
    .filter((message) => state.showTools || message.role !== "tool")
    .filter((message) => state.showContext || message.synthetic_context !== true)
    .filter((message) => !state.roleFilter || message.role === state.roleFilter)
    .filter((message) => !query || displayMessageText(message).toLowerCase().includes(query));
}

function scrollToMessage(index) {
  const target = document.querySelector(`#message-${index + 1}`);
  if (!target) return;
  target.classList.remove("collapsed");
  const toggle = target.querySelector(".message-toggle");
  if (toggle) toggle.textContent = "▼";
  target.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function appendMessageNavItems(container, messages) {
  container.innerHTML = "";
  if (!messages.length) {
    const empty = document.createElement("p");
    empty.className = "props-empty";
    empty.textContent = t("noMessageNav");
    container.append(empty);
    return;
  }

  messages.forEach((message) => {
    const button = document.createElement("button");
    button.className = "message-nav-item";
    button.type = "button";
    button.addEventListener("click", () => scrollToMessage(message._origIdx));

    const top = document.createElement("span");
    top.className = "message-nav-top";
    top.textContent = `#${message._origIdx + 1} · ${message.tool_kind || message.role}`;

    const text = document.createElement("span");
    text.className = "message-nav-text";
    text.textContent = compactText(displayMessageText(message), 72);

    button.append(top, text);
    container.append(button);
  });
}

function createMessageNavSection(messages) {
  const wrap = document.createElement("div");
  wrap.className = "props-section message-nav-section";
  const h3 = document.createElement("h3");
  h3.textContent = t("messageNav");
  const list = document.createElement("div");
  list.className = "message-nav-list";
  appendMessageNavItems(list, filteredConversationMessages(messages));
  wrap.append(h3, list);
  return wrap;
}

function renderMessageNavigation(messages) {
  const filtered = filteredConversationMessages(messages);
  if (elements.messageNavInlineList) {
    appendMessageNavItems(elements.messageNavInlineList, filtered);
  }
  const propsNavList = elements.propsContent?.querySelector(".message-nav-section .message-nav-list");
  if (propsNavList) {
    appendMessageNavItems(propsNavList, filtered);
  }
}

function renderConversation(messages) {
  elements.conversationList.innerHTML = "";

  const filtered = filteredConversationMessages(messages);
  renderMessageNavigation(messages);

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "hero-copy";
    empty.textContent = t("noConversations");
    elements.conversationList.append(empty);
    return;
  }

  filtered.forEach((message) => {
    const fragment = elements.conversationItemTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".message-card");
    card.id = `message-${message._origIdx + 1}`;
    card.dataset.role = message.role;
    card.classList.add("collapsed");
    fragment.querySelector(".message-idx").textContent = `#${message._origIdx + 1}`;
    fragment.querySelector(".message-role").textContent = message.role;
    const toolEl = fragment.querySelector(".message-tool");
    if (message.synthetic_context) {
      toolEl.textContent = t("systemContext");
      toolEl.classList.remove("hidden");
    } else if (message.tool_kind || message.tool_name) {
      toolEl.textContent = [message.tool_kind, message.tool_name].filter(Boolean).join(" · ");
      toolEl.classList.remove("hidden");
    }
    fragment.querySelector(".message-time").textContent = formatTimestamp(message.timestamp);
    const messageText = displayMessageText(message);
    fragment.querySelector(".message-text").textContent = messageText;

    const toggleBtn = fragment.querySelector(".message-toggle");
    toggleBtn.textContent = "▶";
    toggleBtn.addEventListener("click", () => {
      card.classList.toggle("collapsed");
      toggleBtn.textContent = card.classList.contains("collapsed") ? "▶" : "▼";
    });

    const copyBtn = document.createElement("button");
    copyBtn.className = "message-copy-btn";
    copyBtn.title = t("copyMessage");
    copyBtn.textContent = t("copy");
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(messageText).then(() => {
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

  events.forEach((event, idx) => {
    const fragment = elements.rawEventTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".raw-event-card");
    card.classList.add("collapsed");
    fragment.querySelector(".raw-event-idx").textContent = `#${idx + 1}`;
    fragment.querySelector(".raw-event-type").textContent = event.type;
    fragment.querySelector(".raw-event-time").textContent = formatTimestamp(event.timestamp);
    fragment.querySelector(".raw-event-line").textContent = t("linePrefix", { n: event.line_number });
    fragment.querySelector(".raw-event-payload").textContent = JSON.stringify(
      event.payload,
      null,
      2
    );
    const toggleBtn = fragment.querySelector(".raw-event-toggle");
    toggleBtn.textContent = "▶";
    toggleBtn.addEventListener("click", () => {
      card.classList.toggle("collapsed");
      toggleBtn.textContent = card.classList.contains("collapsed") ? "▶" : "▼";
    });
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

function setDetailPlaceholder(title, description = "") {
  const heading = document.createElement("h2");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = description;
  copy.classList.toggle("hidden", !description);
  elements.detailEmpty.replaceChildren(heading, copy);
}

function setCodexMigrationStatus(message, kind = "") {
  if (!elements.codexMigrationStatus) return;
  elements.codexMigrationStatus.textContent = message;
  elements.codexMigrationStatus.dataset.kind = kind;
}

function isCodexMaintenanceEnabled() {
  return state.capabilities?.codex_maintenance?.enabled === true;
}

function selectedCodexMigrationProviders() {
  return Array.from(state.codexMigrationSelectedProviders).sort();
}

function sameProviderSelection(left, right) {
  const first = Array.isArray(left) ? [...left].sort() : [];
  const second = Array.isArray(right) ? [...right].sort() : [];
  return first.length === second.length && first.every((provider, index) => provider === second[index]);
}

function configureCodexMaintenanceUi() {
  const enabled = isCodexMaintenanceEnabled();
  if (elements.codexMigrationCard) {
    elements.codexMigrationCard.dataset.enabled = enabled ? "true" : "false";
  }
  if (elements.codexMaintenanceToggle) {
    elements.codexMaintenanceToggle.checked = enabled;
  }
  [
    elements.codexMigrationPreviewBtn,
    elements.codexMigrationRollbackBtn,
    elements.codexMigrationConfirm,
    elements.codexMigrationRollbackDir
  ].forEach((control) => {
    if (control) control.disabled = !enabled;
  });
  if (!enabled) {
    if (elements.codexMigrationApplyBtn) elements.codexMigrationApplyBtn.disabled = true;
    if (elements.codexMigrationProviderList) {
      elements.codexMigrationProviderList.textContent = t("maintenanceDisabledHint");
    }
    setCodexMigrationStatus(t("maintenanceDisabled"), "warning");
  } else if (!state.codexMigrationPreview) {
    setCodexMigrationStatus(t("migrationNotPreviewed"));
  }
}

async function toggleCodexMaintenance() {
  if (!elements.codexMaintenanceToggle) return;
  const enabled = elements.codexMaintenanceToggle.checked;
  if (!enabled) {
    codexMigrationPreviewRequestGate.cancel();
  }
  elements.codexMaintenanceToggle.disabled = true;
  try {
    const result = await fetchJson("/api/codex-maintenance", {
      method: "POST",
      mutation: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled })
    });
    state.capabilities.codex_maintenance.enabled = result.enabled === true;
    state.codexMigrationPreview = null;
    state.codexMigrationSelectedProviders.clear();
    if (elements.codexMigrationConfirm) elements.codexMigrationConfirm.checked = false;
    resetCodexMigrationMetrics();
    configureCodexMaintenanceUi();
  } catch (error) {
    console.error(error);
    elements.codexMaintenanceToggle.checked = !enabled;
    setCodexMigrationBusy(false);
    configureCodexMaintenanceUi();
    setCodexMigrationStatus(`${t("maintenanceToggleFailed")}: ${error.message}`, "error");
  } finally {
    elements.codexMaintenanceToggle.disabled = false;
  }
}

function updateCodexMigrationApplyState() {
  const preview = state.codexMigrationPreview;
  const confirmed = elements.codexMigrationConfirm?.checked === true;
  const selectedProviders = selectedCodexMigrationProviders();
  const selectionMatchesPlan = sameProviderSelection(selectedProviders, preview?.providers);
  if (elements.codexMigrationApplyBtn) {
    elements.codexMigrationApplyBtn.disabled = !isCodexMaintenanceEnabled() ||
      !confirmed ||
      selectedProviders.length === 0 ||
      !selectionMatchesPlan ||
      !preview?.canApply ||
      !preview?.hasChanges ||
      !preview?.planId;
  }
}

function setCodexMigrationBusy(isBusy) {
  const maintenanceDisabled = !isCodexMaintenanceEnabled();
  [
    elements.codexMigrationPreviewBtn,
    elements.codexMigrationRollbackBtn
  ].forEach((button) => {
    if (button) button.disabled = isBusy || maintenanceDisabled;
  });
  if (elements.codexMigrationConfirm) {
    elements.codexMigrationConfirm.disabled = isBusy || maintenanceDisabled;
  }
  if (elements.codexMigrationRollbackDir) {
    elements.codexMigrationRollbackDir.disabled = isBusy || maintenanceDisabled;
  }
  if (elements.codexMigrationApplyBtn) {
    elements.codexMigrationApplyBtn.disabled = true;
  }
  if (!isBusy) {
    updateCodexMigrationApplyState();
  }
}

function resetCodexMigrationMetrics() {
  if (elements.codexMigrationThreadCount) elements.codexMigrationThreadCount.textContent = "-";
  if (elements.codexMigrationJsonlCount) elements.codexMigrationJsonlCount.textContent = "-";
  if (elements.codexMigrationReplacementCount) elements.codexMigrationReplacementCount.textContent = "-";
  if (elements.codexMigrationCurrentProvider) elements.codexMigrationCurrentProvider.textContent = "-";
  if (elements.codexMigrationTargetProvider) elements.codexMigrationTargetProvider.textContent = "-";
  if (elements.codexMigrationDiagnosticList) elements.codexMigrationDiagnosticList.innerHTML = "";
  if (elements.codexMigrationDiagnostics) elements.codexMigrationDiagnostics.dataset.kind = "neutral";
  if (elements.codexMigrationBackupNotice) elements.codexMigrationBackupNotice.classList.add("hidden");
  if (elements.codexMigrationProviderList) {
    elements.codexMigrationProviderList.textContent = t("migrationNoPreview");
  }
}

function formatCount(value) {
  return new Intl.NumberFormat(getLang() === "zh" ? "zh-CN" : "en").format(Number(value || 0));
}

function renderCodexMigrationDiagnostics(summary) {
  if (elements.codexMigrationCurrentProvider) {
    elements.codexMigrationCurrentProvider.textContent = summary.codexConfig?.activeProvider || "-";
  }
  if (elements.codexMigrationTargetProvider) {
    elements.codexMigrationTargetProvider.textContent = summary.targetProvider || "-";
  }
  if (!elements.codexMigrationDiagnosticList || !elements.codexMigrationDiagnostics) return;

  const list = elements.codexMigrationDiagnosticList;
  list.innerHTML = "";
  const blockers = summary.blockers || [];
  const warnings = summary.warnings || [];
  if (blockers.length) {
    const selectionOnly = blockers.every((item) => item.code === "source_provider_selection_required");
    elements.codexMigrationDiagnostics.dataset.kind = selectionOnly ? "warning" : "error";
    blockers.forEach((item) => {
      const row = document.createElement("li");
      row.textContent = selectionOnly
        ? t("migrationSelectProviders")
        : t("migrationBlocker", { message: item.message });
      list.append(row);
    });
    return;
  }
  elements.codexMigrationDiagnostics.dataset.kind = warnings.length ? "warning" : "ok";
  if (!warnings.length) {
    const row = document.createElement("li");
    row.textContent = t("migrationReady");
    list.append(row);
    return;
  }
  warnings.forEach((item) => {
    const row = document.createElement("li");
    const message = item.code === "current_provider_only"
      ? t("migrationCurrentProviderOnly", { target: summary.targetProvider || "-" })
      : item.message;
    row.textContent = t("migrationWarning", { message });
    list.append(row);
  });
}

function renderCodexMigrationPreview(summary) {
  state.codexMigrationPreview = summary;
  if (summary?.mutation_token) {
    setMutationToken(summary.mutation_token);
  }
  if (!summary) {
    resetCodexMigrationMetrics();
    updateCodexMigrationApplyState();
    return;
  }

  if (elements.codexMigrationThreadCount) {
    elements.codexMigrationThreadCount.textContent = formatCount(summary.threadMatches);
  }
  if (elements.codexMigrationJsonlCount) {
    elements.codexMigrationJsonlCount.textContent = formatCount(summary.jsonlFilesToChange);
  }
  if (elements.codexMigrationReplacementCount) {
    elements.codexMigrationReplacementCount.textContent = formatCount(summary.jsonlSessionMetaReplacements);
  }
  renderCodexMigrationDiagnostics(summary);

  if (elements.codexMigrationProviderList) {
    elements.codexMigrationProviderList.innerHTML = "";
    const mappings = summary.candidateMappings || summary.mappings || [];
    const candidateProviders = new Set(mappings.map((mapping) => mapping.source));
    for (const provider of selectedCodexMigrationProviders()) {
      if (!candidateProviders.has(provider)) {
        state.codexMigrationSelectedProviders.delete(provider);
      }
    }
    if (!mappings.length) {
      elements.codexMigrationProviderList.textContent = t("migrationNoProviders");
    } else {
      mappings.forEach((mapping) => {
        const item = document.createElement("label");
        item.className = "migration-provider-item";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = state.codexMigrationSelectedProviders.has(mapping.source);
        checkbox.disabled = !isCodexMaintenanceEnabled();
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            state.codexMigrationSelectedProviders.add(mapping.source);
          } else {
            state.codexMigrationSelectedProviders.delete(mapping.source);
          }
          if (elements.codexMigrationConfirm) {
            elements.codexMigrationConfirm.checked = false;
          }
          const count = state.codexMigrationSelectedProviders.size;
          setCodexMigrationStatus(
            count > 0 ? t("migrationSelectionChanged") : t("migrationSelectProviders"),
            "warning"
          );
          updateCodexMigrationApplyState();
        });
        const name = document.createElement("span");
        name.textContent = `${mapping.source} → ${mapping.target}`;
        const count = document.createElement("strong");
        count.textContent = t("migrationMappingCounts", {
          threads: formatCount(mapping.threads),
          jsonl: formatCount(mapping.jsonl)
        });
        item.append(checkbox, name, count);
        elements.codexMigrationProviderList.append(item);
      });
    }
  }

  if (summary.backupDir && elements.codexMigrationRollbackDir) {
    elements.codexMigrationRollbackDir.value = summary.backupDir;
  }

  if (elements.codexMigrationBackupNotice) {
    const notice = elements.codexMigrationBackupNotice;
    const label = elements.codexMigrationBackupLabel;
    const pathEl = elements.codexMigrationBackupPath;
    if (summary.backupDir) {
      if (label) label.textContent = t("backupSavedAt");
      if (pathEl) pathEl.textContent = summary.backupDir;
      notice.classList.remove("hidden");
      notice.dataset.done = "true";
    } else if (summary.backupRoot) {
      if (label) label.textContent = t("backupWillSaveTo");
      if (pathEl) {
        pathEl.textContent = `${summary.backupRoot}/${summary.migration || "codex-history-provider-rebucket-v2"}/`;
      }
      notice.classList.remove("hidden");
      notice.dataset.done = "false";
    } else {
      notice.classList.add("hidden");
    }
  }

  updateCodexMigrationApplyState();
}

async function loadCodexMigrationPreview() {
  if (!isCodexMaintenanceEnabled()) {
    configureCodexMaintenanceUi();
    return;
  }
  const request = codexMigrationPreviewRequestGate.begin();
  setCodexMigrationBusy(true);
  setCodexMigrationStatus(t("migrationPreviewing"));
  try {
    const providers = selectedCodexMigrationProviders();
    const params = new URLSearchParams();
    if (providers.length > 0) params.set("providers", providers.join(","));
    const query = params.toString();
    const summary = await fetchJson(`/api/codex-provider-migration/preview${query ? `?${query}` : ""}`, {
      signal: request.signal
    });
    if (!request.isCurrent() || !isCodexMaintenanceEnabled()) return;
    renderCodexMigrationPreview(summary);
    if (summary.selectionRequired) {
      setCodexMigrationStatus(t("migrationSelectProviders"), "warning");
    } else if (!summary.canApply) {
      setCodexMigrationStatus(t("migrationPreviewBlocked", { n: summary.blockers?.length || 0 }), "error");
    } else if (!summary.hasChanges) {
      setCodexMigrationStatus(t("migrationNoChanges"), "ok");
    } else {
      setCodexMigrationStatus(t("migrationPreviewReady", {
        n: summary.providers?.length || 0,
        target: summary.targetProvider || "-"
      }), "ok");
    }
  } catch (error) {
    if (isAbortError(error) || !request.isCurrent()) return;
    console.error(error);
    setCodexMigrationStatus(`${t("migrationPreviewFailed")}: ${error.message}`, "error");
  } finally {
    if (request.isCurrent()) {
      setCodexMigrationBusy(false);
    }
  }
}

async function applyCodexMigration() {
  if (!isCodexMaintenanceEnabled()) {
    configureCodexMaintenanceUi();
    return;
  }
  if (elements.codexMigrationConfirm?.checked !== true) {
    setCodexMigrationStatus(t("migrationNeedConfirm"), "error");
    updateCodexMigrationApplyState();
    return;
  }

  setCodexMigrationBusy(true);
  setCodexMigrationStatus(t("migrationApplying"));
  try {
    const preview = state.codexMigrationPreview;
    if (!preview?.planId) {
      setCodexMigrationStatus(t("migrationNoPreview"), "error");
      return;
    }
    const summary = await fetchJson("/api/codex-provider-migration/apply", {
      method: "POST",
      mutation: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmedCodexAppClosed: true,
        planId: preview.planId,
        providers: preview.providers
      })
    });
    renderCodexMigrationPreview(summary);
    state.codexMigrationPreview = null;
    if (elements.codexMigrationConfirm) {
      elements.codexMigrationConfirm.checked = false;
    }
    setCodexMigrationStatus(
      summary.backupDir
        ? t("migrationAppliedWithBackup", { path: summary.backupDir })
        : t("migrationApplied"),
      "ok"
    );
    await loadFacets();
    await Promise.all([loadSessions(), loadStats()]);
  } catch (error) {
    console.error(error);
    renderCodexMigrationPreview(null);
    setCodexMigrationStatus(`${t("migrationApplyFailed")}: ${error.message}`, "error");
  } finally {
    setCodexMigrationBusy(false);
  }
}

async function rollbackCodexMigration() {
  if (!isCodexMaintenanceEnabled()) {
    configureCodexMaintenanceUi();
    return;
  }
  const backupDir = elements.codexMigrationRollbackDir?.value.trim();
  if (!backupDir) {
    setCodexMigrationStatus(t("migrationNeedBackupDir"), "error");
    return;
  }
  if (elements.codexMigrationConfirm?.checked !== true) {
    setCodexMigrationStatus(t("migrationNeedConfirm"), "error");
    updateCodexMigrationApplyState();
    return;
  }

  setCodexMigrationBusy(true);
  setCodexMigrationStatus(t("migrationRollbacking"));
  try {
    const result = await fetchJson("/api/codex-provider-migration/rollback", {
      method: "POST",
      mutation: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backupDir, confirmedCodexAppClosed: true })
    });
    if (elements.codexMigrationConfirm) {
      elements.codexMigrationConfirm.checked = false;
    }
    await loadFacets();
    await Promise.all([loadSessions(), loadStats()]);
    await loadCodexMigrationPreview();
    setCodexMigrationStatus(
      t("migrationRollbackDone", {
        sqlite: result.restoredSqlite,
        jsonl: result.restoredJsonl
      }),
      "ok"
    );
  } catch (error) {
    console.error(error);
    setCodexMigrationStatus(`${t("migrationRollbackFailed")}: ${error.message}`, "error");
  } finally {
    setCodexMigrationBusy(false);
  }
}

async function loadSessionDetail(id) {
  const request = detailRequestGate.begin();
  try {
    const detail = await fetchJson(`/api/sessions/${encodeURIComponent(id)}`, {
      signal: request.signal
    });
    if (!request.isCurrent() || state.selectedSessionKey !== id) return false;
    state.currentDetail = detail;
    state.roleFilter = "";
    state.detailQuery = "";
    if (elements.detailSearchInput) {
      elements.detailSearchInput.value = "";
    }
    if (elements.showToolsToggle) {
      elements.showToolsToggle.checked = state.showTools;
    }
    if (elements.showContextToggle) {
      elements.showContextToggle.checked = state.showContext;
    }
    document.querySelectorAll("#role-filter .role-filter-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.role === "");
    });
    elements.detailEmpty.classList.add("hidden");
    elements.detailView.classList.remove("hidden");
    const fullCwd = detail.summary.cwd || t("noWorkDir");
    elements.detailTitle.textContent = detail.summary.title || fullCwd.split(/[\\/]/).pop() || fullCwd;
    elements.detailTitle.title = fullCwd;
    renderDetailTags(detail.summary);
    renderPropsPanel(detail.summary, detail.conversation_messages);
    renderConversation(detail.conversation_messages);
    renderRawEvents(detail.raw_events);
    updateTabs();
    if (state._initialized && window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
      scrollToWorkspaceSection(document.querySelector("#detail-panel"));
    }
    return true;
  } catch (error) {
    if (isAbortError(error) || !request.isCurrent()) return false;
    console.error(error);
    showError(`${t("loadDetailFailed")}: ${error.message}`);
    if (state.selectedSessionKey === id) {
      state.currentDetail = null;
      elements.detailView.classList.add("hidden");
      elements.detailEmpty.classList.remove("hidden");
      setDetailPlaceholder(t("loadDetailFailed"), error.message);
    }
    return false;
  }
}

async function loadSessions() {
  const request = sessionRequestGate.begin();
  detailRequestGate.cancel();
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
    syncSessionRoot();

    if (state.selectedSessionKey && !visibleSessions().find((session) => session._key === state.selectedSessionKey)) {
      state.selectedSessionKey = null;
      state.currentDetail = null;
    }

    renderSessionList();

    if (!state._initialized && !state.selectedSessionKey && state.sessions[0]) {
      const first = visibleSessions()[0];
      if (first) state.selectedSessionKey = first._key;
    }

    if (state.selectedSessionKey) {
      elements.sessionList.querySelectorAll(".session-item").forEach((el) => {
        el.classList.toggle("active", el.dataset.sessionKey === state.selectedSessionKey);
      });
      await loadSessionDetail(state.selectedSessionKey);
    } else {
      detailRequestGate.cancel();
      elements.detailView.classList.add("hidden");
      elements.detailEmpty.classList.remove("hidden");
      setDetailPlaceholder(t("selectSession"), t("selectSessionDesc"));
    }
    if (request.isCurrent() && state._initialized) syncUrl();
    return request.isCurrent();
  } catch (error) {
    if (isAbortError(error) || !request.isCurrent()) return false;
    console.error(error);
    showError(`${t("loadListFailed")}: ${error.message}`);
    return false;
  }
}

async function loadMoreSessions() {
  const request = sessionRequestGate.begin();
  try {
    const url = state.searchQuery
      ? buildSearchUrl({ cursor: state.nextCursor })
      : buildSessionsUrl({ cursor: state.nextCursor });
    const data = await fetchJson(url, {
      signal: request.signal
    });
    if (!request.isCurrent()) return false;
    state.sessions = state.sessions.concat(data.sessions);
    state.hasMore = data.has_more;
    state.nextCursor = data.next_cursor;
    renderSessionList();
    return true;
  } catch (error) {
    if (isAbortError(error) || !request.isCurrent()) return false;
    console.error(error);
    showError(`${t("loadMoreFailed")}: ${error.message}`);
    return false;
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

  // 指标卡片：优先使用后端字段，旧数据结构则回退到分组统计。
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
      { label: t("statsEvents"), value: formatCount(stats.total_events) }
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

  // 趋势图。
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
        date.textContent = label.length > 5 ? label.slice(5) : label;

        col.append(val, barWrap, date);
        wrap.append(col);
      });
      trendBody.append(wrap);
    } else {
      trendBody.innerHTML = '<div style="text-align:center;color:var(--muted);padding:60px 0;">—</div>';
    }
  }

  // Provider 分布图。
  const donutBody = document.querySelector("#donut-chart-body");
  if (donutBody) {
    donutBody.innerHTML = "";
    const items = (stats.by_provider || []).slice(0, 6);
    if (items.length) {
      const total = items.reduce((s, i) => s + i.count, 0);
      const colors = ["#0f766e", "#2563eb", "#a15c07", "#b42318", "#16794f", "#7c3aed"];
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

  // 分组排行。
  const grid = elements.statsGrid;
  if (grid) {
    grid.innerHTML = "";
    const sections = [
      { title: t("statsRecentDaily"), items: (stats.by_date || []).slice(-14) },
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
      const max = Math.max(...items.map((i) => i.count), 1);
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
}

async function loadStats() {
  const request = statsRequestGate.begin();
  try {
    const params = buildSessionQuery();
    const url = `/api/stats${params ? "?" + params : ""}`;
    const stats = await fetchJson(url, { signal: request.signal });
    if (!request.isCurrent()) return false;
    state.stats = stats;
    renderStats(stats);
    updateSessionCount();
    return true;
  } catch (error) {
    if (isAbortError(error) || !request.isCurrent()) return false;
    console.error(error);
    showError(`${t("loadStatsFailed")}: ${error.message}`);
    return false;
  }
}

async function loadFacets() {
  state.facets = await fetchJson("/api/facets");
  syncSessionRoot();
  updateFacetFilters();
  syncFilterControls();
}

async function loadCapabilities() {
  try {
    state.capabilities = await fetchJson("/api/capabilities");
    setMutationToken(state.capabilities?.codex_maintenance?.mutation_token);
  } catch (error) {
    console.error(error);
    state.capabilities = { codex_maintenance: { enabled: false } };
  }
}

async function activateWorkspaceView(panel) {
  state.activeView = panel;
  document.body.dataset.view = panel;
  if (elements.appLayout) elements.appLayout.dataset.view = panel;
  if (elements.sidebarLeft) elements.sidebarLeft.dataset.activePanel = panel;

  document.querySelectorAll(".sidebar-tab").forEach((tab) => {
    const active = tab.dataset.sidebarTab === panel;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".sidebar-body").forEach((body) => {
    body.classList.toggle("hidden", body.dataset.sidebarPanel !== panel);
  });

  const detailPanel = document.querySelector("#detail-panel");
  const propsPanel = document.querySelector("#props-panel");
  const statsDashboard = document.querySelector("#stats-dashboard");
  const toolsDashboard = document.querySelector("#tools-dashboard");
  const isList = panel === "list";
  const isStats = panel === "stats";
  const isTools = panel === "tools";
  detailPanel?.classList.toggle("hidden", !isList);
  propsPanel?.classList.toggle("hidden", !isList);
  statsDashboard?.classList.toggle("hidden", !isStats);
  toolsDashboard?.classList.toggle("hidden", !isTools);

}

async function initialize() {
  restoreFromUrl();

  await Promise.all([loadFacets(), loadCapabilities()]);
  resetCodexMigrationMetrics();
  configureCodexMaintenanceUi();

  await loadStats();

  elements.sourceKindFilter?.addEventListener("change", async (event) => {
    state.filters.source_kind = event.target.value;
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  elements.providerFilter?.addEventListener("change", async (event) => {
    state.filters.provider = event.target.value;
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  elements.dateFilter?.addEventListener("change", async (event) => {
    state.filters.date = event.target.value;
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  elements.cwdFilter?.addEventListener("change", async (event) => {
    await setCwdFilter(event.target.value);
  });

  elements.resetFilters?.addEventListener("click", async () => {
    state.filters = { provider: "", source_kind: "", date: "", cwd: "" };
    state.searchQuery = "";
    state.showArchived = false;
    state.showCodexArchived = false;
    state.showHidden = false;
    syncFilterControls();
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  if (elements.refreshBtn) {
    elements.refreshBtn.addEventListener("click", async () => {
      elements.refreshBtn.disabled = true;
      elements.refreshBtn.textContent = t("refreshing");
      try {
        await fetchJson("/api/refresh");
        await loadFacets();
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

  if (elements.showCodexArchivedToggle) {
    elements.showCodexArchivedToggle.addEventListener("change", async () => {
      state.showCodexArchived = elements.showCodexArchivedToggle.checked;
      syncUrl();
      await Promise.all([loadSessions(), loadStats()]);
    });
  }

  if (elements.showHiddenToggle) {
    elements.showHiddenToggle.addEventListener("change", async () => {
      state.showHidden = elements.showHiddenToggle.checked;
      syncUrl();
      await Promise.all([loadSessions(), loadStats()]);
    });
  }

  elements.openCodexArchiveBtn?.addEventListener("click", async () => {
    state.showCodexArchived = true;
    if (elements.showCodexArchivedToggle) elements.showCodexArchivedToggle.checked = true;
    syncUrl();
    await activateWorkspaceView("list");
    await Promise.all([loadSessions(), loadStats()]);
    elements.sidebarLeft?.scrollIntoView({ block: "start" });
  });

  elements.mobileBackBtn?.addEventListener("click", () => scrollToWorkspaceSection(elements.sidebarLeft));

  if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches && elements.projectNav) {
    elements.projectNav.open = false;
  }

  elements.codexMigrationPreviewBtn?.addEventListener("click", loadCodexMigrationPreview);
  elements.codexMaintenanceToggle?.addEventListener("change", toggleCodexMaintenance);
  elements.codexMigrationConfirm?.addEventListener("change", updateCodexMigrationApplyState);
  elements.codexMigrationApplyBtn?.addEventListener("click", applyCodexMigration);
  elements.codexMigrationRollbackBtn?.addEventListener("click", rollbackCodexMigration);

  document.querySelectorAll(".sidebar-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activateWorkspaceView(tab.dataset.sidebarTab).catch((error) => {
        console.error(error);
        showError(error.message);
      });
    });
  });

  const filterToggle = document.querySelector("#filter-toggle");
  if (filterToggle) {
    filterToggle.addEventListener("click", () => {
      const tab = document.querySelector('.sidebar-tab[data-sidebar-tab="list"]');
      if (tab && !tab.classList.contains("active")) tab.click();
      if (elements.sidebarFilters) elements.sidebarFilters.open = true;
      elements.sidebarFilters?.scrollIntoView({ block: "nearest" });
      requestAnimationFrame(() => elements.sourceKindFilter?.focus());
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
  elements.searchInput?.addEventListener("input", (event) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
      const switchedView = state.activeView !== "list";
      if (switchedView) {
        await activateWorkspaceView("list");
      }
      state.searchQuery = event.target.value.trim();
      syncUrl();
      await loadSessions();
      if (switchedView && window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
        scrollToWorkspaceSection(elements.sidebarLeft);
      }
    }, 300);
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      elements.searchInput?.focus();
      elements.searchInput?.select();
    }
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
    const focusedItem = focused?.classList.contains("session-item")
      ? focused
      : focused?.closest(".session-row")?.querySelector(".session-item");
    const idx = items.indexOf(focusedItem);
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
  configureCodexMaintenanceUi();

  if (elements.langToggle) {
    elements.langToggle.addEventListener("click", () => {
      const next = getLang() === "zh" ? "en" : "zh";
      setLang(next);
      rerenderLocalizedContent();
    });
  }

  elements.detailSearchInput?.addEventListener("input", (event) => {
    state.detailQuery = event.target.value.trim();
    if (state.currentDetail) {
      renderConversation(state.currentDetail.conversation_messages || []);
    }
  });

  elements.showToolsToggle?.addEventListener("change", () => {
    state.showTools = elements.showToolsToggle.checked;
    if (state.currentDetail) {
      renderConversation(state.currentDetail.conversation_messages || []);
    }
  });

  elements.showContextToggle?.addEventListener("change", () => {
    state.showContext = elements.showContextToggle.checked;
    if (state.currentDetail) {
      renderConversation(state.currentDetail.conversation_messages || []);
    }
  });

  await loadSessions();
  state._initialized = true;

  const eventSource = new EventSource("/api/events");
  bindSessionEvents(eventSource, {
    refresh: async () => {
      await loadFacets();
      await Promise.all([loadSessions(), loadStats()]);
    },
    onSessionAdded: (summary) => {
      const ariaLive = document.querySelector("#aria-live");
      if (!ariaLive) return;
      ariaLive.textContent = `${t("newSessionAdded")}: ${summary.cwd || summary.id}`;
      setTimeout(() => { ariaLive.textContent = ""; }, 3000);
    },
    onMalformed: (error) => console.warn("Invalid session event payload", error),
    onError: (error) => {
      console.error(error);
      showError(`${t("refreshFailed")}: ${error.message}`);
    }
  });

  // 角色过滤。
  document.querySelectorAll("#role-filter .role-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#role-filter .role-filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.roleFilter = btn.dataset.role;
      if (state.currentDetail) {
        renderConversation(state.currentDetail.conversation_messages || []);
      }
    });
  });
}

initialize().catch((error) => {
  console.error(error);
  elements.sessionList.innerHTML = "";
  const message = document.createElement("p");
  message.className = "hero-copy";
  message.textContent = `${t("loadListFailed")}: ${error.message}`;
  elements.sessionList.append(message);
});
