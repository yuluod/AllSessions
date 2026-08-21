import { t, setLang, getLang, updateStaticI18n } from "./i18n.js";
import {
  DESKTOP_RUNTIME_REQUIRED,
  fetchJson as requestJson,
} from "./api-client.js";
import { createLatestRequestGate, isAbortError } from "./async-coordinator.js";
import { bindTauriSessionEvents } from "./session-events.js";
import {
  cwdParts,
  fillSelect,
  formatDateGroup,
  formatCount,
  formatTimestamp,
  sessionTimestamp,
} from "./session-format.js";
import { exportSessionJson, exportSessionMarkdown } from "./session-export.js";
import { createConversationView } from "./conversation-view.js";
import { renderStats } from "./stats-view.js";
import { createSettingsController } from "./settings-view.js";

const PAGE_LIMIT = 50;
const PROJECT_PREVIEW_LIMIT = 4;
const MOBILE_LAYOUT_QUERY = "(max-width: 760px)";
const INSPECTOR_DRAWER_QUERY = "(max-width: 1320px)";
const ARCHIVE_KEY = "codex_viewer_archived_sessions";
const REMOVED_SESSIONS_KEY = "allsessions_removed_sessions";
const REMOVED_MESSAGES_KEY = "allsessions_removed_messages";
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
  showRemoved: false,
  showAllProjects: false,
  codexMigrationPreview: null,
  codexMigrationSelectedProviders: new Set(),
  codexMigrationApplied: false,
  currentDetail: null,
  detailQuery: "",
  showTools: true,
  showContext: false,
  activeView: "list",
  lastSessionError: null,
  workspaceLoadError: null,
  tauriEventsBound: false,
  filters: {
    provider: "",
    source_kind: "",
    date: "",
    cwd: "",
  },
  roleFilter: "",
};

let pendingDeletion = null;

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
  const archived = !ids.has(id);
  if (!archived) {
    ids.delete(id);
  } else {
    ids.add(id);
  }
  setArchivedIds(ids);
  return archived;
}

function getRemovedSessionIds() {
  try {
    return new Set(
      JSON.parse(localStorage.getItem(REMOVED_SESSIONS_KEY) || "[]")
    );
  } catch {
    return new Set();
  }
}

function setSessionRemoved(id, removed) {
  const ids = getRemovedSessionIds();
  if (removed) ids.add(id);
  else ids.delete(id);
  localStorage.setItem(REMOVED_SESSIONS_KEY, JSON.stringify(Array.from(ids)));
}

function getRemovedMessages() {
  try {
    const value = JSON.parse(
      localStorage.getItem(REMOVED_MESSAGES_KEY) || "{}"
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

function isMessageRemoved(message) {
  const sessionKey =
    state.currentDetail?.summary?._key || state.selectedSessionKey;
  if (!sessionKey || !message?._message_key) return false;
  return (getRemovedMessages()[sessionKey] || []).includes(
    message._message_key
  );
}

function setMessageRemoved(sessionKey, messageKey, removed) {
  const bySession = getRemovedMessages();
  const keys = new Set(bySession[sessionKey] || []);
  if (removed) keys.add(messageKey);
  else keys.delete(messageKey);
  if (keys.size) bySession[sessionKey] = Array.from(keys);
  else delete bySession[sessionKey];
  localStorage.setItem(REMOVED_MESSAGES_KEY, JSON.stringify(bySession));
}

function clearRemovedState(sessionKey, messageKey) {
  if (messageKey) {
    setMessageRemoved(sessionKey, messageKey, false);
    return;
  }
  setSessionRemoved(sessionKey, false);
  const bySession = getRemovedMessages();
  delete bySession[sessionKey];
  localStorage.setItem(REMOVED_MESSAGES_KEY, JSON.stringify(bySession));
}

function isCodexArchivedSession(session) {
  return session?.archived === true && session.archive_source === "codex";
}

function scrollToWorkspaceSection(element) {
  if (!element) return;
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;
  element.scrollIntoView({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "start",
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
  homeLink: document.querySelector("#home-link"),
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
  searchShortcut: document.querySelector("#search-shortcut"),
  resetFilters: document.querySelector("#reset-filters"),
  refreshBtn: document.querySelector("#refresh-btn"),
  langToggle: document.querySelector("#lang-toggle"),
  showArchivedToggle: document.querySelector("#show-archived-toggle"),
  showCodexArchivedToggle: document.querySelector(
    "#show-codex-archived-toggle"
  ),
  showHiddenToggle: document.querySelector("#show-hidden-toggle"),
  showRemovedToggle: document.querySelector("#show-removed-toggle"),
  projectList: document.querySelector("#project-list"),
  activeFilterBar: document.querySelector("#active-filter-bar"),
  sessionList: document.querySelector("#session-list"),
  detailEmpty: document.querySelector("#detail-empty"),
  detailView: document.querySelector("#detail-view"),
  detailTitle: document.querySelector("#detail-title"),
  detailTags: document.querySelector("#detail-tags"),
  propsContent: document.querySelector("#props-content"),
  sessionInspectorToggle: document.querySelector("#session-inspector-toggle"),
  propsCloseBtn: document.querySelector("#props-close-btn"),
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
  trendChartBody: document.querySelector("#trend-chart-body"),
  donutChartBody: document.querySelector("#donut-chart-body"),
  toolsDashboard: document.querySelector("#tools-dashboard"),
  codexRollbackDashboard: document.querySelector("#codex-rollback-dashboard"),
  openCodexRollbackBtn: document.querySelector("#open-codex-rollback-btn"),
  codexRollbackBackBtn: document.querySelector("#codex-rollback-back-btn"),
  codexRollbackCard: document.querySelector(".codex-rollback-card"),
  codexRollbackMaintenanceToggle: document.querySelector(
    "#codex-rollback-maintenance-toggle"
  ),
  codexRollbackStatus: document.querySelector("#codex-rollback-status"),
  codexMigrationCard: document.querySelector("#codex-migration-card"),
  codexMaintenanceToggle: document.querySelector("#codex-maintenance-toggle"),
  codexMigrationPreviewBtn: document.querySelector(
    "#codex-migration-preview-btn"
  ),
  codexMigrationApplyBtn: document.querySelector("#codex-migration-apply-btn"),
  codexMigrationRollbackBtn: document.querySelector(
    "#codex-migration-rollback-btn"
  ),
  codexMigrationConfirm: document.querySelector("#codex-migration-confirm"),
  codexMigrationStatus: document.querySelector("#codex-migration-status"),
  codexMigrationThreadCount: document.querySelector(
    "#codex-migration-thread-count"
  ),
  codexMigrationJsonlCount: document.querySelector(
    "#codex-migration-jsonl-count"
  ),
  codexMigrationReplacementCount: document.querySelector(
    "#codex-migration-replacement-count"
  ),
  codexMigrationDiagnostics: document.querySelector(
    "#codex-migration-diagnostics"
  ),
  codexMigrationMetrics: document.querySelector("#codex-migration-metrics"),
  codexMigrationNextStep: document.querySelector("#codex-migration-next-step"),
  codexMigrationWorkflow: document.querySelector("#codex-migration-workflow"),
  codexMigrationSteps: Array.from(
    document.querySelectorAll("#codex-migration-workflow .maintenance-step")
  ),
  codexMigrationComplete: document.querySelector("#codex-migration-complete"),
  codexMigrationFinishBtn: document.querySelector(
    "#codex-migration-finish-btn"
  ),
  codexMigrationPlanStaleNotice: document.querySelector(
    "#codex-migration-plan-stale"
  ),
  codexMigrationCurrentProvider: document.querySelector(
    "#codex-migration-current-provider"
  ),
  codexMigrationTargetProvider: document.querySelector(
    "#codex-migration-target-provider"
  ),
  codexMigrationDiagnosticList: document.querySelector(
    "#codex-migration-diagnostic-list"
  ),
  codexMigrationProviderList: document.querySelector(
    "#codex-migration-provider-list"
  ),
  codexMigrationRollbackDir: document.querySelector(
    "#codex-migration-rollback-dir"
  ),
  codexMigrationRollbackConfirm: document.querySelector(
    "#codex-migration-rollback-confirm"
  ),
  codexMigrationBackupNotice: document.querySelector(
    "#codex-migration-backup-notice"
  ),
  codexMigrationBackupLabel: document.querySelector(
    "#codex-migration-backup-label"
  ),
  codexMigrationBackupPath: document.querySelector(
    "#codex-migration-backup-path"
  ),
  openCodexArchiveBtn: document.querySelector("#open-codex-archive-btn"),
  mobileBackBtn: document.querySelector("#mobile-back-btn"),
  settingsToggle: document.querySelector("#settings-toggle"),
  settingsDialog: document.querySelector("#settings-dialog"),
  settingsCloseBtn: document.querySelector("#settings-close-btn"),
  settingsLanguageSelect: document.querySelector("#settings-language-select"),
  settingsSources: document.querySelector("#settings-sources"),
  settingsCachePath: document.querySelector("#settings-cache-path"),
  settingsCacheSize: document.querySelector("#settings-cache-size"),
  settingsClearCache: document.querySelector("#settings-clear-cache"),
  settingsVersion: document.querySelector("#settings-version"),
  settingsSaveBtn: document.querySelector("#settings-save-btn"),
  settingsStatus: document.querySelector("#settings-status"),
  sessionDeleteBtn: document.querySelector("#session-delete-btn"),
  deleteDialog: document.querySelector("#delete-dialog"),
  deleteDialogTitle: document.querySelector("#delete-dialog-title"),
  deleteDialogDescription: document.querySelector("#delete-dialog-description"),
  deleteDialogWarning: document.querySelector("#delete-dialog-warning"),
  deleteDialogStatus: document.querySelector("#delete-dialog-status"),
  deleteDialogClose: document.querySelector("#delete-dialog-close"),
  deleteSoftBtn: document.querySelector("#delete-soft-btn"),
  deletePermanentBtn: document.querySelector("#delete-permanent-btn"),
  deleteConfirmBtn: document.querySelector("#delete-confirm-btn"),
  sessionItemTemplate: document.querySelector("#session-item-template"),
  conversationItemTemplate: document.querySelector(
    "#conversation-item-template"
  ),
  rawEventTemplate: document.querySelector("#raw-event-template"),
};

const conversationView = createConversationView({
  state,
  elements,
  isMessageRemoved,
  onRequestDelete: (message) => openDeleteDialog({ kind: "message", message }),
  onRestoreMessage: (message) => restoreRemovedMessage(message),
});
const settingsController = createSettingsController({
  elements,
  onLanguageChanged: () => {
    syncLanguageToggle();
    rerenderLocalizedContent();
  },
  onSaved: () => {
    loadFacets()
      .then(() => Promise.all([loadSessions(), loadStats()]))
      .catch((error) => showError(error.message));
  },
});

// ── URL 状态同步 ──────────────────────────────────────────────────────────────
function syncUrl() {
  const params = new URLSearchParams();
  if (state.filters.provider) params.set("provider", state.filters.provider);
  if (state.filters.source_kind)
    params.set("source_kind", state.filters.source_kind);
  if (state.filters.date) params.set("date", state.filters.date);
  if (state.filters.cwd) params.set("cwd", state.filters.cwd);
  if (state.searchQuery) params.set("q", state.searchQuery);
  if (state.showCodexArchived) params.set("show_codex_archived", "1");
  if (state.showHidden) params.set("show_hidden", "1");
  if (state.showRemoved) params.set("show_removed", "1");
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
  state.showCodexArchived =
    params.get("show_codex_archived") === "1" ||
    params.get("show_codex_archived") === "true";
  state.showHidden =
    params.get("show_hidden") === "1" || params.get("show_hidden") === "true";
  state.showRemoved =
    params.get("show_removed") === "1" || params.get("show_removed") === "true";
  state.selectedSessionKey = params.get("session") || null;
}

function displaySourceLabel(summary) {
  if (isCodexArchivedSession(summary)) {
    return t("codexArchived");
  }
  return summary.display_source || summary.source_kind || "";
}

function sourceKindValue(summary) {
  if (isCodexArchivedSession(summary)) return "codex_archived";
  return summary?.source_kind || "unknown";
}

function sourceKindLabel(sourceKind) {
  if (sourceKind === "codex_archived") return t("codexArchived");
  const source = state.facets?.sources?.find(
    (candidate) => candidate.kind === sourceKind
  );
  return source?.display_name || sourceKind;
}

async function setSourceKindFilter(sourceKind) {
  if (state.filters.source_kind === sourceKind) return;
  state.filters.source_kind = sourceKind;
  syncFilterControls();
  syncUrl();
  await Promise.all([loadSessions(), loadStats()]);
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

  const visibleProjects = state.showAllProjects
    ? projects
    : projects.slice(0, PROJECT_PREVIEW_LIMIT);
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

  const sourceKinds = Array.from(
    new Set([
      ...(state.facets.sources || []).map((source) => source.kind),
      ...(state.facets.source_kinds || []),
    ])
  );
  fillSelect(elements.sourceKindFilter, sourceKinds, sourceKindLabel);
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
  elements.sessionRoot.textContent = t("localSourcesCount", {
    n: roots.length,
  });
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
  if (elements.sourceKindFilter)
    elements.sourceKindFilter.value = state.filters.source_kind;
  if (elements.providerFilter)
    elements.providerFilter.value = state.filters.provider;
  if (elements.dateFilter) elements.dateFilter.value = state.filters.date;
  if (elements.cwdFilter) elements.cwdFilter.value = state.filters.cwd;
  if (elements.searchInput) elements.searchInput.value = state.searchQuery;
  if (elements.showArchivedToggle)
    elements.showArchivedToggle.checked = state.showArchived;
  if (elements.showCodexArchivedToggle) {
    elements.showCodexArchivedToggle.checked = state.showCodexArchived;
  }
  if (elements.showHiddenToggle) {
    elements.showHiddenToggle.checked = state.showHidden;
  }
  if (elements.showRemovedToggle) {
    elements.showRemovedToggle.checked = state.showRemoved;
  }
  renderProjectNav();
}

function rerenderLocalizedContent() {
  syncSessionRoot();
  updateFacetFilters();
  syncFilterControls();
  if (state.workspaceLoadError) {
    renderWorkspaceLoadFailure(state.workspaceLoadError);
  } else {
    renderSessionList();
  }
  if (state.currentDetail) {
    const fullCwd = state.currentDetail.summary.cwd || t("noWorkDir");
    elements.detailTitle.textContent =
      state.currentDetail.summary.title ||
      fullCwd.split(/[\\/]/).pop() ||
      fullCwd;
    elements.detailTitle.title = fullCwd;
    renderDetailTags(state.currentDetail.summary);
    syncSessionDeleteButton();
    renderPropsPanel(
      state.currentDetail.summary,
      state.currentDetail.conversation_messages
    );
    conversationView.renderConversation(
      state.currentDetail.conversation_messages
    );
    renderRawEvents(state.currentDetail.raw_events);
    updateTabs();
  } else {
    setDetailPlaceholder(t("selectSession"), t("selectSessionDesc"));
    setPropsPlaceholder(t("selectSession"));
  }
  if (state.stats) {
    renderStats(state.stats, elements);
  }
  if (state.codexMigrationPreview) {
    renderCodexMigrationPreview(state.codexMigrationPreview);
  } else {
    resetCodexMigrationMetrics();
  }
  configureCodexMaintenanceUi();
}

function syncLanguageToggle() {
  if (!elements.langToggle) return;
  const isChinese = getLang() === "zh";
  elements.langToggle.textContent = t(
    isChinese ? "languageToggleZh" : "languageToggleEn"
  );
  const label = t(isChinese ? "switchToEnglish" : "switchToChinese");
  elements.langToggle.title = label;
  elements.langToggle.setAttribute("aria-label", label);
}

function syncSearchShortcut() {
  if (!elements.searchShortcut) return;
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  elements.searchShortcut.textContent = /^(mac|iphone|ipad|ipod)/i.test(
    platform
  )
    ? "⌘ K"
    : "Ctrl K";
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
    formatError: (status) => t("requestFailed", { status }),
  });
}

function visibleSessions() {
  const archivedIds = getArchivedIds();
  const removedIds = getRemovedSessionIds();
  return state.sessions.filter(
    (session) =>
      (state.showArchived || !archivedIds.has(session._key)) &&
      (state.showRemoved || !removedIds.has(session._key))
  );
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
  } else if (type === "showRemoved") {
    state.showRemoved = false;
    syncFilterControls();
    renderSessionList();
    return;
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
    entries.push({
      type: "search",
      label: t("filterSearch"),
      value: state.searchQuery,
    });
  }
  if (state.filters.source_kind) {
    entries.push({
      type: "source_kind",
      label: t("sourceKind"),
      value: state.filters.source_kind,
    });
  }
  if (state.filters.provider) {
    entries.push({
      type: "provider",
      label: t("provider"),
      value: state.filters.provider,
    });
  }
  if (state.filters.date) {
    entries.push({ type: "date", label: t("date"), value: state.filters.date });
  }
  if (state.filters.cwd) {
    const { main } = cwdParts(state.filters.cwd);
    entries.push({
      type: "cwd",
      label: t("cwd"),
      value: main,
      title: state.filters.cwd,
    });
  }
  if (state.showArchived) {
    entries.push({
      type: "showArchived",
      label: t("showArchived"),
      value: t("filterEnabled"),
    });
  }
  if (state.showCodexArchived) {
    entries.push({
      type: "showCodexArchived",
      label: t("showCodexArchived"),
      value: t("filterEnabled"),
    });
  }
  if (state.showHidden) {
    entries.push({
      type: "showHidden",
      label: t("showHidden"),
      value: t("filterEnabled"),
    });
  }
  if (state.showRemoved) {
    entries.push({
      type: "showRemoved",
      label: t("showRemoved"),
      value: t("filterEnabled"),
    });
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
    const clearLabel = t("clearFilter", {
      label: `${entry.label}: ${entry.value}`,
    });
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
  const removedIds = getRemovedSessionIds();
  sessions.forEach((session) => {
    const archived = archivedIds.has(session._key);
    const removed = removedIds.has(session._key);

    const fragment = elements.sessionItemTemplate.content.cloneNode(true);
    const row = fragment.querySelector(".session-row");
    const button = fragment.querySelector(".session-item");
    const sourceKind = sourceKindValue(session);
    row.dataset.sourceKind = sourceKind;
    button.dataset.sourceKind = sourceKind;
    button.dataset.sessionKey = session._key;
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
    button.querySelector(".session-time").textContent = formatTimestamp(
      sessionTimestamp(session)
    );
    button.querySelector(".session-provider").textContent =
      session.model_provider || "unknown";
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
    cwdMain.classList.toggle("hidden", Boolean(preview));
    if (cwdPath)
      cwdPath.classList.toggle("hidden", Boolean(preview) || !pathParts.path);
    button.querySelector(".session-source").textContent =
      session.source || session.originator || t("unknownSource");
    const sourceKindEl = button.querySelector(".session-source-kind");
    sourceKindEl.textContent = displaySourceLabel(session);
    sourceKindEl.dataset.sourceKind = sourceKind;
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
    if (removed) {
      button.classList.add("removed");
      const removedBadge = document.createElement("span");
      removedBadge.className = "session-hidden-reason";
      removedBadge.textContent = t("removedSession");
      button.querySelector(".session-tertiary").append(removedBadge);
    }

    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "session-archive-btn";
    const archiveLabel = archived ? t("unarchive") : t("archive");
    archiveBtn.title = archiveLabel;
    archiveBtn.setAttribute("aria-label", archiveLabel);
    archiveBtn.textContent = archived ? "↩" : "⊗";
    archiveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isArchived = toggleArchive(session._key);
      renderSessionList();
      const ariaLive = document.querySelector("#aria-live");
      if (ariaLive) {
        ariaLive.textContent = t(
          isArchived ? "sessionArchived" : "sessionUnarchived"
        );
      }
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
    Object.entries(attributes).forEach(([key, value]) =>
      node.setAttribute(key, value)
    );
    svg.append(node);
  };

  if (icon === "calendar") {
    add("rect", {
      x: "3",
      y: "4",
      width: "18",
      height: "18",
      rx: "2",
      ry: "2",
    });
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
    {
      text: displaySourceLabel(summary),
      cls: "tag-source",
      sourceKind: sourceKindValue(summary),
    },
    { text: hiddenReasonLabel(summary), cls: "tag-hidden" },
    {
      text: getRemovedSessionIds().has(summary._key) ? t("removedSession") : "",
      cls: "tag-removed",
    },
    {
      text: summary.detail_truncated ? t("partialDetail") : "",
      cls: "tag-hidden",
    },
  ];

  tags.forEach(({ text, cls, icon, sourceKind }) => {
    if (!text) return;
    const span = document.createElement("span");
    span.className = `detail-tag ${cls || ""}`.trim();
    if (sourceKind) span.dataset.sourceKind = sourceKind;
    if (icon) {
      span.append(createTagIcon(icon), document.createTextNode(` ${text}`));
    } else {
      span.append(document.createTextNode(text));
    }
    elements.detailTags.append(span);
  });
}

function syncSessionDeleteButton() {
  if (!elements.sessionDeleteBtn) return;
  const key = state.currentDetail?.summary?._key;
  const removed = key && getRemovedSessionIds().has(key);
  elements.sessionDeleteBtn.textContent = t(
    removed ? "manageRemovedSession" : "deleteSession"
  );
}

function announce(message) {
  const ariaLive = document.querySelector("#aria-live");
  if (ariaLive) ariaLive.textContent = message;
}

function closeDeleteDialog() {
  if (elements.deleteConfirmBtn?.disabled) return;
  elements.deleteDialog?.close();
  pendingDeletion = null;
}

function openDeleteDialog({ kind, message = null }) {
  const sessionKey = state.currentDetail?.summary?._key;
  if (!sessionKey || !elements.deleteDialog) return;
  const messageKey = message?._message_key || null;
  const removed =
    kind === "session"
      ? getRemovedSessionIds().has(sessionKey)
      : isMessageRemoved(message);
  pendingDeletion = { kind, sessionKey, messageKey, removed };
  elements.deleteDialogTitle.textContent = t(
    removed
      ? "manageRemovedTitle"
      : kind === "session"
        ? "removeSessionTitle"
        : "removeMessageTitle"
  );
  elements.deleteDialogDescription.textContent = t(
    kind === "session" ? "removeSessionDesc" : "removeMessageDesc"
  );
  elements.deleteDialogStatus.textContent = "";
  elements.deleteDialogWarning.classList.add("hidden");
  elements.deleteConfirmBtn.classList.add("hidden");
  elements.deletePermanentBtn.classList.remove("hidden");
  elements.deleteSoftBtn.classList.remove("hidden");
  elements.deleteSoftBtn.textContent = t(
    removed ? "restore" : "removeFromAllSessions"
  );
  elements.deleteDialog.showModal();
  elements.deleteSoftBtn.focus();
}

function refreshDeletionViews() {
  renderSessionList();
  if (!state.currentDetail) return;
  renderDetailTags(state.currentDetail.summary);
  syncSessionDeleteButton();
  conversationView.renderConversation(
    state.currentDetail.conversation_messages || []
  );
  renderPropsPanel(
    state.currentDetail.summary,
    state.currentDetail.conversation_messages || []
  );
}

function restoreRemovedMessage(message) {
  const sessionKey = state.currentDetail?.summary?._key;
  if (!sessionKey || !message?._message_key) return;
  setMessageRemoved(sessionKey, message._message_key, false);
  refreshDeletionViews();
  announce(t("contentRestored"));
}

function applySoftDeletion() {
  if (!pendingDeletion) return;
  const { kind, sessionKey, messageKey, removed } = pendingDeletion;
  if (kind === "session") {
    setSessionRemoved(sessionKey, !removed);
    if (!removed && !state.showRemoved) {
      state.selectedSessionKey = null;
      state.currentDetail = null;
      showSelectSessionPlaceholder();
      syncUrl();
    }
  } else if (messageKey) {
    setMessageRemoved(sessionKey, messageKey, !removed);
  }
  closeDeleteDialog();
  refreshDeletionViews();
  announce(t(removed ? "contentRestored" : "contentRemoved"));
}

function showPermanentDeleteConfirmation() {
  if (!pendingDeletion) return;
  elements.deleteDialogWarning.classList.remove("hidden");
  elements.deleteSoftBtn.classList.add("hidden");
  elements.deletePermanentBtn.classList.add("hidden");
  elements.deleteConfirmBtn.classList.remove("hidden");
  elements.deleteConfirmBtn.focus();
}

async function confirmPermanentDeletion() {
  if (!pendingDeletion) return;
  const target = { ...pendingDeletion };
  elements.deleteConfirmBtn.disabled = true;
  elements.deleteDialogClose.disabled = true;
  elements.deleteDialogStatus.textContent = t("deleting");
  try {
    const url =
      target.kind === "session"
        ? "/api/sessions/delete"
        : "/api/sessions/delete-message";
    const body = { sessionKey: target.sessionKey, confirmed: true };
    if (target.messageKey) body.messageKey = target.messageKey;
    await fetchJson(url, { method: "POST", body });
    clearRemovedState(target.sessionKey, target.messageKey);
    pendingDeletion = null;
    elements.deleteDialog.close();
    if (target.kind === "session") {
      state.selectedSessionKey = null;
      state.currentDetail = null;
      showSelectSessionPlaceholder();
    }
    await loadFacets();
    await Promise.all([loadSessions(), loadStats()]);
    announce(
      t(
        target.kind === "session"
          ? "sessionDeletedPermanently"
          : "messageDeletedPermanently"
      )
    );
  } catch (error) {
    elements.deleteDialogStatus.textContent = `${t("deleteFailed")}: ${error.message}`;
  } finally {
    elements.deleteConfirmBtn.disabled = false;
    elements.deleteDialogClose.disabled = false;
  }
}

// ── 属性面板 ────────────────────────────────────────────────────────────────────
function renderPropsPanel(summary, messages = []) {
  const basic = [
    { label: "Provider", value: summary.model_provider || "unknown" },
    { label: t("source"), value: displaySourceLabel(summary) || "-" },
    { label: t("visibility"), value: visibilityLabel(summary) },
    { label: t("messages"), value: String(summary.message_count || 0) },
    { label: t("systemContext"), value: String(summary.context_count || 0) },
    { label: t("toolCalls"), value: String(summary.tool_count || 0) },
  ];
  const tech = [
    { label: t("sessionId"), value: summary.id, copyable: true },
    { label: t("filePath"), value: summary.file_path, copyable: true },
    { label: t("cwdLabel"), value: summary.cwd || "-", copyable: true },
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
            setTimeout(() => {
              btn.textContent = "copy";
            }, 1500);
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
    conversationView.createMessageNavSection(messages)
  );
}

function setPropsPlaceholder(message) {
  if (!elements.propsContent) return;
  const placeholder = document.createElement("div");
  placeholder.className = "props-empty";
  placeholder.textContent = message;
  elements.propsContent.replaceChildren(placeholder);
}

function setInspectorOpen(open) {
  const panel = elements.propsContent?.closest(".props-panel");
  const drawerLayout = window.matchMedia(INSPECTOR_DRAWER_QUERY).matches;
  const isOpen = Boolean(drawerLayout && open && state.currentDetail);
  panel?.classList.toggle("is-open", isOpen);
  panel?.setAttribute(
    "aria-hidden",
    !drawerLayout || isOpen ? "false" : "true"
  );
  elements.sessionInspectorToggle?.setAttribute(
    "aria-expanded",
    isOpen ? "true" : "false"
  );
}

function syncInspectorLayout() {
  const panel = elements.propsContent?.closest(".props-panel");
  setInspectorOpen(panel?.classList.contains("is-open") === true);
}

function syncRoleFilterButtons() {
  document
    .querySelectorAll("#role-filter .role-filter-btn")
    .forEach((button) => {
      const active = button.dataset.role === state.roleFilter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
}

function setRawEventCardCollapsed(card, toggleButton, collapsed) {
  card.classList.toggle("collapsed", collapsed);
  toggleButton.textContent = collapsed ? "▶" : "▼";
  toggleButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
  const label = collapsed ? t("expandRawEvent") : t("collapseRawEvent");
  toggleButton.title = label;
  toggleButton.setAttribute("aria-label", label);
}

function renderRawEvents(events) {
  elements.rawEvents.innerHTML = "";

  events.forEach((event, idx) => {
    const fragment = elements.rawEventTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".raw-event-card");
    fragment.querySelector(".raw-event-idx").textContent = `#${idx + 1}`;
    fragment.querySelector(".raw-event-type").textContent = event.type;
    fragment.querySelector(".raw-event-time").textContent = formatTimestamp(
      event.timestamp
    );
    fragment.querySelector(".raw-event-line").textContent = t("linePrefix", {
      n: event.line_number,
    });
    const payload = fragment.querySelector(".raw-event-payload");
    payload.textContent = JSON.stringify(event.payload, null, 2);
    payload.id = `raw-event-payload-${idx + 1}`;
    const toggleBtn = fragment.querySelector(".raw-event-toggle");
    toggleBtn.setAttribute("aria-controls", payload.id);
    setRawEventCardCollapsed(card, toggleBtn, true);
    toggleBtn.addEventListener("click", () => {
      setRawEventCardCollapsed(
        card,
        toggleBtn,
        !card.classList.contains("collapsed")
      );
    });
    elements.rawEvents.append(fragment);
  });
}

function updateTabs() {
  elements.tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === state.activeTab;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
    button.tabIndex = isActive ? 0 : -1;
  });
  const conversationActive = state.activeTab === "conversation";
  elements.conversationTab.classList.toggle("hidden", !conversationActive);
  elements.conversationTab.setAttribute(
    "aria-hidden",
    conversationActive ? "false" : "true"
  );
  elements.rawTab.classList.toggle("hidden", conversationActive);
  elements.rawTab.setAttribute(
    "aria-hidden",
    conversationActive ? "true" : "false"
  );
}

let errorTimer = null;
function showError(message) {
  let banner = document.querySelector("#error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "error-banner";
    banner.className = "error-banner";
    banner.setAttribute("role", "alert");
    banner.setAttribute("aria-live", "assertive");
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

function setCodexRollbackStatus(message, kind = "") {
  if (!elements.codexRollbackStatus) return;
  elements.codexRollbackStatus.textContent = message;
  elements.codexRollbackStatus.dataset.kind = kind;
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
  return (
    first.length === second.length &&
    first.every((provider, index) => provider === second[index])
  );
}

function isCodexMigrationPlanStale() {
  return (
    state.codexMigrationPreview !== null &&
    !sameProviderSelection(
      selectedCodexMigrationProviders(),
      state.codexMigrationPreview.providers
    )
  );
}

function updateCodexMigrationPreviewButton() {
  if (!elements.codexMigrationPreviewBtn) return;
  if (state.codexMigrationApplied) {
    elements.codexMigrationPreviewBtn.textContent = t("migrationCompleteTitle");
    return;
  }
  const preview = state.codexMigrationPreview;
  const selectedProviders = selectedCodexMigrationProviders();
  const hasCandidates =
    (preview?.candidateMappings || preview?.mappings || []).length > 0;
  let key = "scanHistoricalProviders";
  if (preview && selectedProviders.length > 0) {
    key = "rebuildRepairPlan";
  } else if (preview && hasCandidates) {
    key = "buildExactRepairPlan";
  } else if (preview) {
    key = "rebuildRepairPlan";
  }
  elements.codexMigrationPreviewBtn.textContent = t(key);
}

function updateCodexMigrationStepStates() {
  const preview = state.codexMigrationPreview;
  const selectedProviders = selectedCodexMigrationProviders();
  let phase = "disabled";
  let activeStep = 1;
  if (state.codexMigrationApplied) {
    phase = "complete";
    activeStep = 5;
  } else if (isCodexMaintenanceEnabled()) {
    if (!preview || !selectedProviders.length || isCodexMigrationPlanStale()) {
      phase = preview ? "select" : "scan";
      activeStep = 2;
    } else if (!preview.canApply || !preview.hasChanges) {
      phase = "review";
      activeStep = 3;
    } else {
      phase = "execute";
      activeStep = 4;
    }
  }

  if (elements.codexMigrationWorkflow) {
    elements.codexMigrationWorkflow.dataset.phase = phase;
  }
  elements.codexMigrationSteps.forEach((step, index) => {
    const stepNumber = index + 1;
    step.dataset.state =
      stepNumber < activeStep
        ? "complete"
        : stepNumber === activeStep
          ? "active"
          : "pending";
  });
  elements.codexMigrationComplete?.classList.toggle(
    "hidden",
    !state.codexMigrationApplied
  );
  elements.codexMigrationPreviewBtn?.classList.toggle(
    "hidden",
    state.codexMigrationApplied
  );
  elements.codexMigrationConfirm
    ?.closest(".migration-actions")
    ?.classList.toggle("hidden", state.codexMigrationApplied);
}

function updateCodexMigrationNextStep() {
  if (!elements.codexMigrationNextStep) return;
  const preview = state.codexMigrationPreview;
  const selectedProviders = selectedCodexMigrationProviders();
  let key = "nextStepEnableMaintenance";
  if (isCodexMaintenanceEnabled()) {
    if (state.codexMigrationApplied) {
      key = "nextStepRepairDone";
    } else if (!preview) {
      key = "nextStepScanProviders";
    } else if (
      !selectedProviders.length &&
      (preview.candidateMappings || preview.mappings || []).length > 0
    ) {
      key = "nextStepSelectProviders";
    } else if (isCodexMigrationPlanStale()) {
      key = "nextStepRebuildPlan";
    } else if (!preview.canApply) {
      key = "nextStepResolveBlockers";
    } else if (!preview.hasChanges) {
      key = "nextStepNoChanges";
    } else if (elements.codexMigrationConfirm?.checked !== true) {
      key = "nextStepConfirmClosed";
    } else {
      key = "nextStepApplyPlan";
    }
  }
  elements.codexMigrationNextStep.textContent = t(key);
}

function syncCodexMigrationFlowState() {
  const stale = isCodexMigrationPlanStale();
  if (elements.codexMigrationMetrics) {
    elements.codexMigrationMetrics.dataset.stale = String(stale);
  }
  if (elements.codexMigrationDiagnostics) {
    elements.codexMigrationDiagnostics.dataset.stale = String(stale);
  }
  elements.codexMigrationPlanStaleNotice?.classList.toggle("hidden", !stale);
  updateCodexMigrationStepStates();
  updateCodexMigrationPreviewButton();
  updateCodexMigrationNextStep();
  updateCodexMigrationApplyState();
}

function configureCodexMaintenanceUi() {
  const enabled = isCodexMaintenanceEnabled();
  if (elements.codexMigrationCard) {
    elements.codexMigrationCard.dataset.enabled = enabled ? "true" : "false";
  }
  if (elements.codexRollbackCard) {
    elements.codexRollbackCard.dataset.enabled = enabled ? "true" : "false";
  }
  if (elements.codexMaintenanceToggle) {
    elements.codexMaintenanceToggle.checked = enabled;
  }
  if (elements.codexRollbackMaintenanceToggle) {
    elements.codexRollbackMaintenanceToggle.checked = enabled;
  }
  [
    elements.codexMigrationPreviewBtn,
    elements.codexMigrationRollbackBtn,
    elements.codexMigrationConfirm,
    elements.codexMigrationRollbackConfirm,
    elements.codexMigrationRollbackDir,
    elements.codexMigrationFinishBtn,
  ].forEach((control) => {
    if (control) control.disabled = !enabled;
  });
  if (!enabled) {
    if (elements.codexMigrationApplyBtn)
      elements.codexMigrationApplyBtn.disabled = true;
    if (elements.codexMigrationProviderList) {
      elements.codexMigrationProviderList.textContent = t(
        "maintenanceDisabledHint"
      );
    }
    setCodexMigrationStatus(t("maintenanceDisabled"), "warning");
    setCodexRollbackStatus(t("rollbackMaintenanceDisabled"), "warning");
  } else {
    if (!state.codexMigrationPreview) {
      setCodexMigrationStatus(t("migrationNotPreviewed"));
    }
    setCodexRollbackStatus(t("rollbackReady"));
  }
  syncCodexMigrationFlowState();
}

async function toggleCodexMaintenance(event) {
  const enabled =
    event?.currentTarget?.checked ??
    elements.codexMaintenanceToggle?.checked === true;
  if (!enabled) {
    codexMigrationPreviewRequestGate.cancel();
  }
  [
    elements.codexMaintenanceToggle,
    elements.codexRollbackMaintenanceToggle,
  ].forEach((toggle) => {
    if (toggle) toggle.disabled = true;
  });
  try {
    const result = await fetchJson("/api/codex-maintenance", {
      method: "POST",
      mutation: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    state.capabilities.codex_maintenance.enabled = result.enabled === true;
    state.codexMigrationPreview = null;
    state.codexMigrationSelectedProviders.clear();
    state.codexMigrationApplied = false;
    if (elements.codexMigrationConfirm)
      elements.codexMigrationConfirm.checked = false;
    if (elements.codexMigrationRollbackConfirm)
      elements.codexMigrationRollbackConfirm.checked = false;
    resetCodexMigrationMetrics();
    configureCodexMaintenanceUi();
  } catch (error) {
    console.error(error);
    setCodexMigrationBusy(false);
    configureCodexMaintenanceUi();
    const message = `${t("maintenanceToggleFailed")}: ${error.message}`;
    setCodexMigrationStatus(message, "error");
    setCodexRollbackStatus(message, "error");
  } finally {
    [
      elements.codexMaintenanceToggle,
      elements.codexRollbackMaintenanceToggle,
    ].forEach((toggle) => {
      if (toggle) toggle.disabled = false;
    });
  }
}

function updateCodexMigrationApplyState() {
  const preview = state.codexMigrationPreview;
  const confirmed = elements.codexMigrationConfirm?.checked === true;
  const selectedProviders = selectedCodexMigrationProviders();
  const selectionMatchesPlan = sameProviderSelection(
    selectedProviders,
    preview?.providers
  );
  if (elements.codexMigrationApplyBtn) {
    elements.codexMigrationApplyBtn.disabled =
      !isCodexMaintenanceEnabled() ||
      !confirmed ||
      selectedProviders.length === 0 ||
      !selectionMatchesPlan ||
      !preview?.canApply ||
      !preview?.hasChanges ||
      !preview?.planId;
  }
}

function setCodexMigrationBusy(
  isBusy,
  { allowMaintenanceToggle = false } = {}
) {
  const maintenanceDisabled = !isCodexMaintenanceEnabled();
  if (elements.codexMaintenanceToggle) {
    elements.codexMaintenanceToggle.disabled =
      isBusy && !allowMaintenanceToggle;
  }
  if (elements.codexRollbackMaintenanceToggle) {
    elements.codexRollbackMaintenanceToggle.disabled =
      isBusy && !allowMaintenanceToggle;
  }
  [
    elements.codexMigrationPreviewBtn,
    elements.codexMigrationRollbackBtn,
  ].forEach((button) => {
    if (button) button.disabled = isBusy || maintenanceDisabled;
  });
  if (elements.codexMigrationConfirm) {
    elements.codexMigrationConfirm.disabled =
      isBusy || maintenanceDisabled || state.codexMigrationApplied;
  }
  if (elements.codexMigrationRollbackConfirm) {
    elements.codexMigrationRollbackConfirm.disabled =
      isBusy || maintenanceDisabled;
  }
  if (elements.codexMigrationRollbackDir) {
    elements.codexMigrationRollbackDir.disabled = isBusy || maintenanceDisabled;
  }
  if (elements.codexMigrationFinishBtn) {
    elements.codexMigrationFinishBtn.disabled =
      isBusy || maintenanceDisabled || !state.codexMigrationApplied;
  }
  if (elements.codexMigrationApplyBtn) {
    elements.codexMigrationApplyBtn.disabled = true;
  }
  if (!isBusy) {
    syncCodexMigrationFlowState();
  }
}

function resetCodexMigrationMetrics() {
  if (elements.codexMigrationThreadCount)
    elements.codexMigrationThreadCount.textContent = "-";
  if (elements.codexMigrationJsonlCount)
    elements.codexMigrationJsonlCount.textContent = "-";
  if (elements.codexMigrationReplacementCount)
    elements.codexMigrationReplacementCount.textContent = "-";
  if (elements.codexMigrationCurrentProvider)
    elements.codexMigrationCurrentProvider.textContent = "-";
  if (elements.codexMigrationTargetProvider)
    elements.codexMigrationTargetProvider.textContent = "-";
  if (elements.codexMigrationDiagnosticList)
    elements.codexMigrationDiagnosticList.innerHTML = "";
  if (elements.codexMigrationDiagnostics)
    elements.codexMigrationDiagnostics.dataset.kind = "neutral";
  if (elements.codexMigrationBackupNotice)
    elements.codexMigrationBackupNotice.classList.add("hidden");
  if (elements.codexMigrationProviderList) {
    elements.codexMigrationProviderList.textContent = t("migrationNoPreview");
  }
  syncCodexMigrationFlowState();
}

function renderCodexMigrationDiagnostics(summary) {
  if (elements.codexMigrationCurrentProvider) {
    elements.codexMigrationCurrentProvider.textContent =
      summary.codexConfig?.activeProvider || "-";
  }
  if (elements.codexMigrationTargetProvider) {
    elements.codexMigrationTargetProvider.textContent =
      summary.targetProvider || "-";
  }
  if (
    !elements.codexMigrationDiagnosticList ||
    !elements.codexMigrationDiagnostics
  )
    return;

  const list = elements.codexMigrationDiagnosticList;
  list.innerHTML = "";
  const blockers = summary.blockers || [];
  const warnings = summary.warnings || [];
  if (blockers.length) {
    const selectionOnly = blockers.every(
      (item) => item.code === "source_provider_selection_required"
    );
    elements.codexMigrationDiagnostics.dataset.kind = selectionOnly
      ? "warning"
      : "error";
    blockers.forEach((item) => {
      const row = document.createElement("li");
      row.textContent = selectionOnly
        ? t("migrationSelectProviders")
        : t("migrationBlocker", { message: item.message });
      list.append(row);
    });
    return;
  }
  elements.codexMigrationDiagnostics.dataset.kind = warnings.length
    ? "warning"
    : "ok";
  if (!warnings.length) {
    const row = document.createElement("li");
    row.textContent = t("migrationReady");
    list.append(row);
    return;
  }
  warnings.forEach((item) => {
    const row = document.createElement("li");
    const message =
      item.code === "current_provider_only"
        ? t("migrationCurrentProviderOnly", {
            target: summary.targetProvider || "-",
          })
        : item.message;
    row.textContent = t("migrationWarning", { message });
    list.append(row);
  });
}

function renderCodexMigrationPreview(summary) {
  state.codexMigrationPreview = summary;
  if (!summary) {
    resetCodexMigrationMetrics();
    updateCodexMigrationApplyState();
    return;
  }

  if (elements.codexMigrationThreadCount) {
    elements.codexMigrationThreadCount.textContent = formatCount(
      summary.threadMatches
    );
  }
  if (elements.codexMigrationJsonlCount) {
    elements.codexMigrationJsonlCount.textContent = formatCount(
      summary.jsonlFilesToChange
    );
  }
  if (elements.codexMigrationReplacementCount) {
    elements.codexMigrationReplacementCount.textContent = formatCount(
      summary.jsonlSessionMetaReplacements
    );
  }
  renderCodexMigrationDiagnostics(summary);

  if (elements.codexMigrationProviderList) {
    elements.codexMigrationProviderList.innerHTML = "";
    const mappings = summary.candidateMappings || summary.mappings || [];
    const candidateProviders = new Set(
      mappings.map((mapping) => mapping.source)
    );
    for (const provider of selectedCodexMigrationProviders()) {
      if (!candidateProviders.has(provider)) {
        state.codexMigrationSelectedProviders.delete(provider);
      }
    }
    if (!mappings.length) {
      elements.codexMigrationProviderList.textContent = t(
        "migrationNoProviders"
      );
    } else {
      mappings.forEach((mapping) => {
        const item = document.createElement("label");
        item.className = "migration-provider-item";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = state.codexMigrationSelectedProviders.has(
          mapping.source
        );
        checkbox.disabled =
          !isCodexMaintenanceEnabled() || state.codexMigrationApplied;
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            state.codexMigrationSelectedProviders.add(mapping.source);
          } else {
            state.codexMigrationSelectedProviders.delete(mapping.source);
          }
          state.codexMigrationApplied = false;
          if (elements.codexMigrationConfirm) {
            elements.codexMigrationConfirm.checked = false;
          }
          const count = state.codexMigrationSelectedProviders.size;
          setCodexMigrationStatus(
            count > 0
              ? t("migrationSelectionChanged")
              : t("migrationSelectProviders"),
            "warning"
          );
          syncCodexMigrationFlowState();
        });
        const name = document.createElement("span");
        name.textContent = `${mapping.source} → ${mapping.target}`;
        const count = document.createElement("strong");
        count.textContent = t("migrationMappingCounts", {
          threads: formatCount(mapping.threads),
          jsonl: formatCount(mapping.jsonl),
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

  syncCodexMigrationFlowState();
}

async function loadCodexMigrationPreview() {
  if (!isCodexMaintenanceEnabled()) {
    configureCodexMaintenanceUi();
    return;
  }
  if (state.codexMigrationApplied) return;
  const request = codexMigrationPreviewRequestGate.begin();
  setCodexMigrationBusy(true, { allowMaintenanceToggle: true });
  setCodexMigrationStatus(t("migrationPreviewing"));
  try {
    const providers = selectedCodexMigrationProviders();
    const params = new URLSearchParams();
    if (providers.length > 0) params.set("providers", providers.join(","));
    const query = params.toString();
    const summary = await fetchJson(
      `/api/codex-provider-migration/preview${query ? `?${query}` : ""}`,
      {
        signal: request.signal,
      }
    );
    if (!request.isCurrent() || !isCodexMaintenanceEnabled()) return;
    state.codexMigrationApplied = false;
    renderCodexMigrationPreview(summary);
    if (summary.selectionRequired) {
      setCodexMigrationStatus(t("migrationSelectProviders"), "warning");
    } else if (!summary.canApply) {
      setCodexMigrationStatus(
        t("migrationPreviewBlocked", { n: summary.blockers?.length || 0 }),
        "error"
      );
    } else if (!summary.hasChanges) {
      setCodexMigrationStatus(t("migrationNoChanges"), "ok");
    } else {
      setCodexMigrationStatus(
        t("migrationPreviewReady", {
          n: summary.providers?.length || 0,
          target: summary.targetProvider || "-",
        }),
        "ok"
      );
    }
  } catch (error) {
    if (isAbortError(error) || !request.isCurrent()) return;
    console.error(error);
    setCodexMigrationStatus(
      `${t("migrationPreviewFailed")}: ${error.message}`,
      "error"
    );
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
  state.codexMigrationApplied = false;
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
        providers: preview.providers,
      }),
    });
    state.codexMigrationApplied = true;
    state.codexMigrationSelectedProviders.clear();
    renderCodexMigrationPreview(summary);
    state.codexMigrationPreview = null;
    if (elements.codexMigrationProviderList) {
      elements.codexMigrationProviderList.textContent = t(
        "migrationCompletedSources"
      );
    }
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
    setCodexMigrationStatus(
      `${t("migrationApplyFailed")}: ${error.message}`,
      "error"
    );
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
    setCodexRollbackStatus(t("migrationNeedBackupDir"), "error");
    return;
  }
  if (elements.codexMigrationRollbackConfirm?.checked !== true) {
    setCodexRollbackStatus(t("migrationNeedConfirm"), "error");
    return;
  }

  setCodexMigrationBusy(true);
  setCodexRollbackStatus(t("migrationRollbacking"));
  try {
    const result = await fetchJson("/api/codex-provider-migration/rollback", {
      method: "POST",
      mutation: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backupDir, confirmedCodexAppClosed: true }),
    });
    if (elements.codexMigrationRollbackConfirm) {
      elements.codexMigrationRollbackConfirm.checked = false;
    }
    state.codexMigrationApplied = false;
    state.codexMigrationSelectedProviders.clear();
    await loadFacets();
    await Promise.all([loadSessions(), loadStats()]);
    await loadCodexMigrationPreview();
    setCodexRollbackStatus(
      t("migrationRollbackDone", {
        sqlite: result.restoredSqlite,
        jsonl: result.restoredJsonl,
      }),
      "ok"
    );
  } catch (error) {
    console.error(error);
    setCodexRollbackStatus(
      `${t("migrationRollbackFailed")}: ${error.message}`,
      "error"
    );
  } finally {
    setCodexMigrationBusy(false);
  }
}

async function loadSessionDetail(id, { silent = false } = {}) {
  const request = detailRequestGate.begin();
  try {
    const detail = await fetchJson(`/api/sessions/${encodeURIComponent(id)}`, {
      signal: request.signal,
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
    syncRoleFilterButtons();
    elements.detailEmpty.classList.add("hidden");
    elements.detailView.classList.remove("hidden");
    const fullCwd = detail.summary.cwd || t("noWorkDir");
    elements.detailTitle.textContent =
      detail.summary.title || fullCwd.split(/[\\/]/).pop() || fullCwd;
    elements.detailTitle.title = fullCwd;
    renderDetailTags(detail.summary);
    syncSessionDeleteButton();
    renderPropsPanel(detail.summary, detail.conversation_messages);
    conversationView.renderConversation(detail.conversation_messages);
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

function showSelectSessionPlaceholder() {
  detailRequestGate.cancel();
  elements.detailView.classList.add("hidden");
  elements.detailEmpty.classList.remove("hidden");
  setDetailPlaceholder(t("selectSession"), t("selectSessionDesc"));
  setPropsPlaceholder(t("selectSession"));
}

async function loadSessions({ reportError = true, background = false } = {}) {
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

async function loadMoreSessions() {
  const request = sessionRequestGate.begin();
  try {
    const url = state.searchQuery
      ? buildSearchUrl({ cursor: state.nextCursor })
      : buildSessionsUrl({ cursor: state.nextCursor });
    const data = await fetchJson(url, {
      signal: request.signal,
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

async function loadStats() {
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

async function loadFacets() {
  state.facets = await fetchJson("/api/facets");
  syncSessionRoot();
  updateFacetFilters();
  syncFilterControls();
}

async function loadCapabilities() {
  try {
    state.capabilities = await fetchJson("/api/capabilities");
  } catch (error) {
    console.error(error);
    state.capabilities = { codex_maintenance: { enabled: false } };
  }
}

function isDesktopRuntimeUnavailable(error) {
  return error instanceof Error && error.code === DESKTOP_RUNTIME_REQUIRED;
}

function renderWorkspaceLoadFailure(error) {
  state.workspaceLoadError = error;
  const message =
    error instanceof Error && error.message ? error.message : t("errorUnknown");
  const stateCard = document.createElement("section");
  stateCard.className = "workspace-load-state";
  stateCard.setAttribute("role", "alert");

  const heading = document.createElement("h2");
  heading.textContent = t("workspaceUnavailable");

  const copy = document.createElement("p");
  copy.textContent = isDesktopRuntimeUnavailable(error)
    ? t("desktopAppRequired")
    : t("workspaceLoadHelp");

  const retryButton = document.createElement("button");
  retryButton.className = "ghost-button";
  retryButton.type = "button";
  retryButton.textContent = t("retry");
  retryButton.addEventListener("click", async () => {
    retryButton.disabled = true;
    retryButton.textContent = t("retrying");
    await loadInitialWorkspace();
  });

  stateCard.append(heading, copy);
  if (!isDesktopRuntimeUnavailable(error)) {
    const detail = document.createElement("p");
    detail.className = "workspace-load-detail";
    detail.textContent = message;
    stateCard.append(detail);
  }
  stateCard.append(retryButton);
  elements.sessionList.replaceChildren(stateCard);
  elements.activeFilterBar?.replaceChildren();
  elements.sessionCount.textContent = "-";
  elements.sessionRoot.textContent = t("workspaceUnavailable");
  elements.sessionRoot.removeAttribute("title");
}

async function bindTauriSessionEventsOnce() {
  if (state.tauriEventsBound) return;
  try {
    await bindTauriSessionEvents({
      refresh: async () => {
        await loadFacets();
        await Promise.all([loadSessions({ background: true }), loadStats()]);
      },
      onSessionAdded: (summary) => {
        const ariaLive = document.querySelector("#aria-live");
        if (!ariaLive) return;
        ariaLive.textContent = `${t("newSessionAdded")}: ${summary.cwd || summary.id}`;
        setTimeout(() => {
          ariaLive.textContent = "";
        }, 3000);
      },
      onMalformed: (error) =>
        console.warn("Invalid session event payload", error),
      onError: (error) => {
        console.error(error);
        showError(`${t("refreshFailed")}: ${error.message}`);
      },
    });
    state.tauriEventsBound = true;
  } catch (error) {
    console.warn("Tauri session event binding is unavailable", error);
  }
}

async function loadInitialWorkspace() {
  try {
    await Promise.all([loadFacets(), loadCapabilities()]);
    resetCodexMigrationMetrics();
    configureCodexMaintenanceUi();
    const sessionsLoaded = await loadSessions({ reportError: false });
    if (!sessionsLoaded) {
      throw state.lastSessionError || new Error(t("loadListFailed"));
    }
    state._initialized = true;
    state.workspaceLoadError = null;
    void loadStats();
    await bindTauriSessionEventsOnce();
    return true;
  } catch (error) {
    console.error(error);
    state._initialized = false;
    renderWorkspaceLoadFailure(error);
    return false;
  }
}

async function returnHome() {
  detailRequestGate.cancel();
  state.filters = { provider: "", source_kind: "", date: "", cwd: "" };
  state.searchQuery = "";
  state.showArchived = false;
  state.showCodexArchived = false;
  state.showHidden = false;
  state.showRemoved = false;
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

function openCodexRollbackView() {
  elements.toolsDashboard?.classList.add("hidden");
  elements.codexRollbackDashboard?.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "auto" });
}

function closeCodexRollbackView() {
  elements.codexRollbackDashboard?.classList.add("hidden");
  elements.toolsDashboard?.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "auto" });
}

async function activateWorkspaceView(panel) {
  state.activeView = panel;
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
  document.querySelectorAll(".sidebar-body").forEach((body) => {
    body.classList.toggle("hidden", body.dataset.sidebarPanel !== panel);
  });

  const detailPanel = document.querySelector("#detail-panel");
  const propsPanel = document.querySelector("#props-panel");
  const statsDashboard = document.querySelector("#stats-dashboard");
  const toolsDashboard = document.querySelector("#tools-dashboard");
  const codexRollbackDashboard = document.querySelector(
    "#codex-rollback-dashboard"
  );
  const isList = panel === "list";
  const isStats = panel === "stats";
  const isTools = panel === "tools";
  if (!isList) setInspectorOpen(false);
  detailPanel?.classList.toggle("hidden", !isList);
  propsPanel?.classList.toggle("hidden", !isList);
  statsDashboard?.classList.toggle("hidden", !isStats);
  toolsDashboard?.classList.toggle("hidden", !isTools);
  codexRollbackDashboard?.classList.add("hidden");
}

async function initialize() {
  restoreFromUrl();
  resetCodexMigrationMetrics();
  configureCodexMaintenanceUi();
  syncInspectorLayout();
  window
    .matchMedia(INSPECTOR_DRAWER_QUERY)
    .addEventListener("change", syncInspectorLayout);

  elements.homeLink?.addEventListener("click", (event) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    returnHome().catch((error) => {
      console.error(error);
      showError(`${t("loadListFailed")}: ${error.message}`);
    });
  });

  elements.sourceKindFilter?.addEventListener("change", async (event) => {
    await setSourceKindFilter(event.target.value);
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
    state.showRemoved = false;
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
        await Promise.all([loadSessions({ background: true }), loadStats()]);
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

  if (elements.showRemovedToggle) {
    elements.showRemovedToggle.addEventListener("change", () => {
      state.showRemoved = elements.showRemovedToggle.checked;
      syncUrl();
      renderSessionList();
      if (state.currentDetail) {
        conversationView.renderConversation(
          state.currentDetail.conversation_messages || []
        );
      }
    });
  }

  elements.openCodexArchiveBtn?.addEventListener("click", async () => {
    state.showCodexArchived = true;
    if (elements.showCodexArchivedToggle)
      elements.showCodexArchivedToggle.checked = true;
    syncUrl();
    await activateWorkspaceView("list");
    await Promise.all([loadSessions(), loadStats()]);
    elements.sidebarLeft?.scrollIntoView({ block: "start" });
  });

  elements.mobileBackBtn?.addEventListener("click", () =>
    scrollToWorkspaceSection(elements.sidebarLeft)
  );

  elements.sessionDeleteBtn?.addEventListener("click", () =>
    openDeleteDialog({ kind: "session" })
  );
  elements.deleteDialogClose?.addEventListener("click", closeDeleteDialog);
  elements.deleteSoftBtn?.addEventListener("click", applySoftDeletion);
  elements.deletePermanentBtn?.addEventListener(
    "click",
    showPermanentDeleteConfirmation
  );
  elements.deleteConfirmBtn?.addEventListener(
    "click",
    confirmPermanentDeletion
  );
  elements.deleteDialog?.addEventListener("click", (event) => {
    if (event.target === elements.deleteDialog) closeDeleteDialog();
  });
  elements.deleteDialog?.addEventListener("cancel", (event) => {
    if (elements.deleteConfirmBtn?.disabled) event.preventDefault();
    else pendingDeletion = null;
  });

  elements.sessionInspectorToggle?.addEventListener("click", () => {
    const panel = elements.propsContent?.closest(".props-panel");
    setInspectorOpen(!panel?.classList.contains("is-open"));
  });
  elements.propsCloseBtn?.addEventListener("click", () => {
    setInspectorOpen(false);
    elements.sessionInspectorToggle?.focus();
  });

  if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches && elements.projectNav) {
    elements.projectNav.open = false;
  }

  elements.codexMigrationPreviewBtn?.addEventListener(
    "click",
    loadCodexMigrationPreview
  );
  elements.codexMaintenanceToggle?.addEventListener(
    "change",
    toggleCodexMaintenance
  );
  elements.codexRollbackMaintenanceToggle?.addEventListener(
    "change",
    toggleCodexMaintenance
  );
  elements.openCodexRollbackBtn?.addEventListener(
    "click",
    openCodexRollbackView
  );
  elements.codexRollbackBackBtn?.addEventListener(
    "click",
    closeCodexRollbackView
  );
  elements.codexMigrationFinishBtn?.addEventListener("click", async () => {
    if (!elements.codexMaintenanceToggle) return;
    elements.codexMaintenanceToggle.checked = false;
    await toggleCodexMaintenance();
  });
  elements.codexMigrationConfirm?.addEventListener(
    "change",
    syncCodexMigrationFlowState
  );
  elements.codexMigrationApplyBtn?.addEventListener(
    "click",
    applyCodexMigration
  );
  elements.codexMigrationRollbackBtn?.addEventListener(
    "click",
    rollbackCodexMigration
  );

  const workspaceTabs = Array.from(document.querySelectorAll(".sidebar-tab"));
  workspaceTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      activateWorkspaceView(tab.dataset.sidebarTab).catch((error) => {
        console.error(error);
        showError(error.message);
      });
    });
    tab.addEventListener("keydown", (event) => {
      const currentIndex = workspaceTabs.indexOf(tab);
      let nextIndex = null;
      if (event.key === "ArrowRight")
        nextIndex = (currentIndex + 1) % workspaceTabs.length;
      if (event.key === "ArrowLeft")
        nextIndex =
          (currentIndex - 1 + workspaceTabs.length) % workspaceTabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = workspaceTabs.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      workspaceTabs[nextIndex].focus();
      workspaceTabs[nextIndex].click();
    });
  });

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
    if (
      event.key === "Escape" &&
      elements.propsContent
        ?.closest(".props-panel")
        ?.classList.contains("is-open")
    ) {
      setInspectorOpen(false);
      elements.sessionInspectorToggle?.focus();
      return;
    }
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
      let next = null;
      if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
      if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
      if (e.key === "Home") next = 0;
      if (e.key === "End") next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      tabs[next].focus();
      tabs[next].click();
    });
  });

  elements.sessionList.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      elements.sessionList.querySelectorAll(".session-item")
    );
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
  syncLanguageToggle();
  syncSearchShortcut();
  configureCodexMaintenanceUi();

  if (elements.langToggle) {
    elements.langToggle.addEventListener("click", () => {
      const next = getLang() === "zh" ? "en" : "zh";
      setLang(next);
      syncLanguageToggle();
      rerenderLocalizedContent();
    });
  }

  settingsController.bind();

  elements.detailSearchInput?.addEventListener("input", (event) => {
    state.detailQuery = event.target.value.trim();
    if (state.currentDetail) {
      conversationView.renderConversation(
        state.currentDetail.conversation_messages || []
      );
    }
  });

  elements.showToolsToggle?.addEventListener("change", () => {
    state.showTools = elements.showToolsToggle.checked;
    if (state.currentDetail) {
      conversationView.renderConversation(
        state.currentDetail.conversation_messages || []
      );
    }
  });

  elements.showContextToggle?.addEventListener("change", () => {
    state.showContext = elements.showContextToggle.checked;
    if (state.currentDetail) {
      conversationView.renderConversation(
        state.currentDetail.conversation_messages || []
      );
    }
  });

  document.querySelectorAll("#role-filter .role-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.roleFilter = btn.dataset.role;
      syncRoleFilterButtons();
      if (state.currentDetail) {
        conversationView.renderConversation(
          state.currentDetail.conversation_messages || []
        );
      }
    });
  });

  await loadInitialWorkspace();
}

initialize().catch((error) => {
  console.error(error);
  renderWorkspaceLoadFailure(error);
});
