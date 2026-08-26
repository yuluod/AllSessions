import { t, getLang, updateStaticI18n } from "./i18n.js";
import {
  DESKTOP_RUNTIME_REQUIRED,
  fetchJson as requestJson,
} from "./api-client.js";
import {
  createLatestRequestGate,
  isAbortError,
  mapWithConcurrency,
} from "./async-coordinator.js";
import { bindTauriSessionEvents } from "./session-events.js";
import {
  cwdParts,
  fillSelect,
  formatDateGroup,
  formatListTimestamp,
  formatTimestamp,
  sessionTimestamp,
} from "./session-format.js";
import {
  exportSessionCollection,
  exportSessionJson,
  exportSessionMarkdown,
} from "./session-export.js";
import { createConversationView } from "./conversation-view.js";
import { createMaintenanceController } from "./maintenance-view.js";
import { renderStats } from "./stats-view.js";
import { createSettingsController } from "./settings-view.js";
import { getThemeState, initTheme, toggleScheme } from "./theme-manager.js";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

initTheme();

const PAGE_LIMIT = 50;
const MAX_BULK_EXPORT_SESSIONS = 20;
const BULK_EXPORT_CONCURRENCY = 4;
const PROJECT_PREVIEW_LIMIT = 4;
const MOBILE_LAYOUT_QUERY = "(max-width: 760px)";
const INSPECTOR_DRAWER_QUERY = "(max-width: 1640px)";
const COMPACT_WORKSPACE_QUERY =
  "(min-width: 761px) and (max-width: 1640px)";
const SOURCE_RAIL_COLLAPSED_KEY = "allsessions_source_rail_collapsed";
const SOURCE_RAIL_AGENTS = [
  { agent: "codex", kinds: ["codex", "codex_archived"] },
  { agent: "claude", kinds: ["claude"] },
  { agent: "gemini", kinds: ["gemini"] },
  { agent: "pi", kinds: ["pi"] },
  { agent: "kimi", kinds: ["kimi"] },
  { agent: "opencode", kinds: ["opencode"] },
];
const ARCHIVE_KEY = "codex_viewer_archived_sessions";
const REMOVED_SESSIONS_KEY = "allsessions_removed_sessions";
const REMOVED_MESSAGES_KEY = "allsessions_removed_messages";
const sessionRequestGate = createLatestRequestGate();
const detailRequestGate = createLatestRequestGate();
const statsRequestGate = createLatestRequestGate();

const state = {
  capabilities: null,
  diagnostics: null,
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
  favoriteOnly: false,
  showAllProjects: false,
  currentDetail: null,
  detailQuery: "",
  showTools: true,
  showContext: false,
  activeView: "list",
  lastSessionError: null,
  workspaceLoadError: null,
  recoverySettingsOpened: false,
  tauriEventsBound: false,
  filters: {
    provider: "",
    source_kind: "",
    date: "",
    cwd: "",
    tag: "",
  },
  roleFilter: "",
  workspace: {
    sessions: {},
    removed_messages: {},
    saved_filters: [],
    storage: null,
  },
  selectedSessionKeys: new Set(),
};

let pendingDeletion = null;

function readLegacyArchivedIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function readLegacyRemovedSessionIds() {
  try {
    return new Set(
      JSON.parse(localStorage.getItem(REMOVED_SESSIONS_KEY) || "[]")
    );
  } catch {
    return new Set();
  }
}

function readLegacyRemovedMessages() {
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
  return message?._removed === true;
}

function sessionWorkspace(sessionOrKey) {
  const key =
    typeof sessionOrKey === "string" ? sessionOrKey : sessionOrKey?._key;
  return state.workspace.sessions?.[key] || sessionOrKey?.workspace || {};
}

async function updateSessionWorkspace(sessionKey, patch) {
  const result = await fetchJson("/api/workspace/session", {
    method: "POST",
    body: { sessionKey, ...patch },
  });
  state.workspace.sessions[sessionKey] = result.workspace;
  const summary = state.sessions.find((item) => item._key === sessionKey);
  if (summary) summary.workspace = result.workspace;
  if (state.currentDetail?.summary?._key === sessionKey) {
    state.currentDetail.summary.workspace = result.workspace;
  }
  return result.workspace;
}

async function updateMessageWorkspace(sessionKey, messageKey, removed) {
  await fetchJson("/api/workspace/message", {
    method: "POST",
    body: { sessionKey, messageKey, removed },
  });
  const messages = state.currentDetail?.conversation_messages || [];
  const message = messages.find((item) => item._message_key === messageKey);
  if (message) message._removed = removed;
}

async function migrateLegacyWorkspace() {
  const archived = Array.from(readLegacyArchivedIds());
  const removed = Array.from(readLegacyRemovedSessionIds());
  const removedMessages = readLegacyRemovedMessages();
  if (
    !archived.length &&
    !removed.length &&
    !Object.keys(removedMessages).length
  ) {
    return;
  }
  await fetchJson("/api/workspace/migrate-legacy", {
    method: "POST",
    body: {
      archivedSessions: archived,
      removedSessions: removed,
      removedMessages,
    },
  });
  localStorage.removeItem(ARCHIVE_KEY);
  localStorage.removeItem(REMOVED_SESSIONS_KEY);
  localStorage.removeItem(REMOVED_MESSAGES_KEY);
}

async function loadWorkspaceState() {
  await migrateLegacyWorkspace();
  state.workspace = await fetchJson("/api/workspace");
  renderSavedFilters();
  updateBulkToolbar();
}

function currentFilterValue() {
  return {
    ...state.filters,
    q: state.searchQuery,
    show_archived: state.showArchived,
    show_codex_archived: state.showCodexArchived,
    show_hidden: state.showHidden,
    show_removed: state.showRemoved,
    favorite: state.favoriteOnly,
  };
}

function applyFilterValue(filter = {}) {
  state.filters = {
    provider: filter.provider || "",
    source_kind: filter.source_kind || "",
    date: filter.date || "",
    cwd: filter.cwd || "",
    tag: filter.tag || "",
  };
  state.searchQuery = filter.q || "";
  state.showArchived = filter.show_archived === true;
  state.showCodexArchived = filter.show_codex_archived === true;
  state.showHidden = filter.show_hidden === true;
  state.showRemoved = filter.show_removed === true;
  state.favoriteOnly = filter.favorite === true;
}

function renderSavedFilters() {
  if (!elements.savedFilterList) return;
  elements.savedFilterList.replaceChildren();
  const filters = state.workspace.saved_filters || [];
  if (!filters.length) {
    const empty = document.createElement("span");
    empty.className = "saved-filter-empty";
    empty.textContent = t("noSavedFilters");
    elements.savedFilterList.append(empty);
    return;
  }
  filters.forEach((saved) => {
    const chip = document.createElement("span");
    chip.className = "saved-filter-chip";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = saved.name;
    apply.title = t("applySavedFilter", { name: saved.name });
    apply.addEventListener("click", async () => {
      applyFilterValue(saved.filter);
      syncFilterControls();
      syncUrl();
      await Promise.all([loadSessions(), loadStats()]);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "saved-filter-delete";
    remove.textContent = "×";
    remove.title = t("deleteSavedFilter");
    remove.setAttribute("aria-label", t("deleteSavedFilter"));
    remove.addEventListener("click", async () => {
      try {
        await fetchJson("/api/workspace/saved-filter/delete", {
          method: "POST",
          body: { id: saved.id },
        });
        state.workspace.saved_filters = filters.filter(
          (filter) => filter.id !== saved.id
        );
        renderSavedFilters();
        announce(t("savedFilterDeleted"));
      } catch (error) {
        showError(`${t("workspaceSaveFailed")}: ${error.message}`);
      }
    });
    chip.append(apply, remove);
    elements.savedFilterList.append(chip);
  });
}

async function saveCurrentFilter() {
  const name = elements.savedFilterName?.value.trim();
  if (!name) {
    elements.savedFilterName?.focus();
    return;
  }
  elements.saveFilterBtn.disabled = true;
  try {
    const saved = await fetchJson("/api/workspace/saved-filter", {
      method: "POST",
      body: { name, filter: currentFilterValue() },
    });
    state.workspace.saved_filters = [
      saved,
      ...(state.workspace.saved_filters || []),
    ];
    elements.savedFilterName.value = "";
    renderSavedFilters();
    announce(t("savedFilterCreated"));
  } catch (error) {
    showError(`${t("workspaceSaveFailed")}: ${error.message}`);
  } finally {
    elements.saveFilterBtn.disabled = false;
  }
}

function updateBulkToolbar() {
  const count = state.selectedSessionKeys.size;
  elements.bulkToolbar?.classList.toggle(
    "hidden",
    state.sessions.length === 0 && count === 0
  );
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

function setSessionSelected(sessionKey, selected) {
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

async function exportSelectedSessions() {
  const keys = Array.from(state.selectedSessionKeys);
  if (!keys.length) return;
  if (keys.length > MAX_BULK_EXPORT_SESSIONS) {
    showError(
      t("bulkExportTooMany", {
        n: MAX_BULK_EXPORT_SESSIONS,
      })
    );
    return;
  }
  elements.bulkExportBtn.disabled = true;
  const originalLabel = elements.bulkExportBtn.textContent;
  elements.bulkExportBtn.textContent = t("bulkExporting");
  try {
    const details = await mapWithConcurrency(
      keys,
      BULK_EXPORT_CONCURRENCY,
      (key) => fetchJson(`/api/sessions/${encodeURIComponent(key)}`)
    );
    exportSessionCollection(
      details,
      elements.bulkExportFormat?.value || "json",
      { redact: elements.bulkRedactToggle?.checked === true }
    );
  } catch (error) {
    showError(`${t("bulkExportFailed")}: ${error.message}`);
  } finally {
    elements.bulkExportBtn.disabled = false;
    elements.bulkExportBtn.textContent = originalLabel;
  }
}

function parseWorkspaceTags(value) {
  return Array.from(
    new Set(
      value
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

function syncSessionWorkspaceControls(summary) {
  const workspace = sessionWorkspace(summary);
  const favorite = workspace.favorite === true;
  elements.sessionFavoriteBtn?.setAttribute(
    "aria-pressed",
    favorite ? "true" : "false"
  );
  const favoriteLabel = elements.sessionFavoriteBtn?.querySelector("span");
  if (favoriteLabel)
    favoriteLabel.textContent = t(favorite ? "unfavorite" : "favorite");
  if (elements.sessionTagsInput) {
    elements.sessionTagsInput.value = (workspace.tags || []).join(", ");
  }
  if (elements.sessionNoteInput) {
    elements.sessionNoteInput.value = workspace.note || "";
  }
  if (elements.revealSourceBtn) {
    elements.revealSourceBtn.disabled = !summary.file_path;
  }
  if (elements.revealProjectBtn) {
    elements.revealProjectBtn.disabled = !summary.cwd;
  }
}

async function revealCurrentPath(kind) {
  const summary = state.currentDetail?.summary;
  const path = kind === "source" ? summary?.file_path : summary?.cwd;
  if (!path) return;
  try {
    await revealItemInDir(path);
  } catch (error) {
    showError(`${t("revealFailed")}: ${error.message || error}`);
  }
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
  railToggle: document.querySelector("#rail-toggle"),
  sidebarLeft: document.querySelector(".sidebar-left"),
  sidebarFilters: document.querySelector("#sidebar-filters"),
  projectNav: document.querySelector(".project-nav"),
  sessionRoot: document.querySelector("#session-root"),
  sessionCount: document.querySelector("#session-count"),
  sourceKindFilter: document.querySelector("#source-kind-filter"),
  sourceRailItems: Array.from(
    document.querySelectorAll("#source-rail-list [data-source-kind]")
  ),
  providerFilter: document.querySelector("#provider-filter"),
  dateFilter: document.querySelector("#date-filter"),
  cwdFilter: document.querySelector("#cwd-filter"),
  workspaceTagFilter: document.querySelector("#workspace-tag-filter"),
  favoriteOnlyToggle: document.querySelector("#favorite-only-toggle"),
  savedFilterName: document.querySelector("#saved-filter-name"),
  saveFilterBtn: document.querySelector("#save-filter-btn"),
  savedFilterList: document.querySelector("#saved-filter-list"),
  searchInput: document.querySelector("#search-input"),
  searchShortcut: document.querySelector("#search-shortcut"),
  resetFilters: document.querySelector("#reset-filters"),
  refreshBtn: document.querySelector("#refresh-btn"),
  showArchivedToggle: document.querySelector("#show-archived-toggle"),
  showCodexArchivedToggle: document.querySelector(
    "#show-codex-archived-toggle"
  ),
  showHiddenToggle: document.querySelector("#show-hidden-toggle"),
  showRemovedToggle: document.querySelector("#show-removed-toggle"),
  projectList: document.querySelector("#project-list"),
  activeFilterBar: document.querySelector("#active-filter-bar"),
  sessionList: document.querySelector("#session-list"),
  bulkToolbar: document.querySelector("#bulk-toolbar"),
  selectVisibleBtn: document.querySelector("#select-visible-btn"),
  bulkSelectionCount: document.querySelector("#bulk-selection-count"),
  bulkActions: document.querySelector("#bulk-actions"),
  bulkExportFormat: document.querySelector("#bulk-export-format"),
  bulkRedactToggle: document.querySelector("#bulk-redact-toggle"),
  bulkExportBtn: document.querySelector("#bulk-export-btn"),
  clearSelectionBtn: document.querySelector("#clear-selection-btn"),
  statusHealthButton: document.querySelector("#status-health-button"),
  statusHealthText: document.querySelector("#status-health-text"),
  statusFilterText: document.querySelector("#status-filter-text"),
  statusLanguage: document.querySelector("#status-language"),
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
  exportRedactToggle: document.querySelector("#export-redact-toggle"),
  sessionFavoriteBtn: document.querySelector("#session-favorite-btn"),
  sessionOrganizeMenu: document.querySelector("#session-organize-menu"),
  sessionTagsInput: document.querySelector("#session-tags-input"),
  sessionNoteInput: document.querySelector("#session-note-input"),
  saveSessionWorkspaceBtn: document.querySelector(
    "#save-session-workspace-btn"
  ),
  revealSourceBtn: document.querySelector("#reveal-source-btn"),
  revealProjectBtn: document.querySelector("#reveal-project-btn"),
  statsDashboard: document.querySelector("#stats-dashboard"),
  statsMetrics: document.querySelector("#stats-metrics"),
  statsGrid: document.querySelector("#stats-grid"),
  trendChartBody: document.querySelector("#trend-chart-body"),
  agentChartBody: document.querySelector("#agent-chart-body"),
  toolsDashboard: document.querySelector("#tools-dashboard"),
  openCodexArchiveBtn: document.querySelector("#open-codex-archive-btn"),
  mobileBackBtn: document.querySelector("#mobile-back-btn"),
  schemeToggle: document.querySelector("#scheme-toggle"),
  settingsToggle: document.querySelector("#settings-toggle"),
  settingsDialog: document.querySelector("#settings-dialog"),
  settingsCloseBtn: document.querySelector("#settings-close-btn"),
  settingsTabs: Array.from(document.querySelectorAll("[data-settings-tab]")),
  settingsPanels: Array.from(
    document.querySelectorAll("[data-settings-panel]")
  ),
  settingsLanguageSelect: document.querySelector("#settings-language-select"),
  settingsThemeInputs: Array.from(
    document.querySelectorAll('[name="settings-theme"]')
  ),
  settingsSchemeInputs: Array.from(
    document.querySelectorAll('[name="settings-scheme"]')
  ),
  settingsKeepRunning: document.querySelector("#settings-keep-running"),
  settingsStartupUpdates: document.querySelector("#settings-startup-updates"),
  settingsSourceOverview: document.querySelector("#settings-source-overview"),
  settingsSources: document.querySelector("#settings-sources"),
  settingsRecovery: document.querySelector("#settings-recovery"),
  settingsRecoveryMessage: document.querySelector("#settings-recovery-message"),
  settingsDiagnosticsMeta: document.querySelector("#settings-diagnostics-meta"),
  settingsCopyDiagnostics: document.querySelector("#settings-copy-diagnostics"),
  settingsCachePath: document.querySelector("#settings-cache-path"),
  settingsCacheSize: document.querySelector("#settings-cache-size"),
  settingsDeletionBackupPath: document.querySelector(
    "#settings-deletion-backup-path"
  ),
  settingsDeletionBackupCount: document.querySelector(
    "#settings-deletion-backup-count"
  ),
  settingsWorkspacePath: document.querySelector("#settings-workspace-path"),
  settingsWorkspaceCount: document.querySelector("#settings-workspace-count"),
  settingsClearCache: document.querySelector("#settings-clear-cache"),
  settingsVersion: document.querySelector("#settings-version"),
  settingsCheckUpdate: document.querySelector("#settings-check-update"),
  settingsRepositoryLink: document.querySelector("#settings-repository-link"),
  settingsLicenseLink: document.querySelector("#settings-license-link"),
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
    rerenderLocalizedContent();
  },
  onSaved: () => {
    Promise.all([loadFacets(), loadWorkspaceDiagnostics()])
      .then(() => Promise.all([loadSessions(), loadStats()]))
      .catch((error) => showError(error.message));
  },
});
const maintenanceController = createMaintenanceController({
  requestJson: fetchJson,
  refreshData: async () => {
    await Promise.all([loadFacets(), loadWorkspaceDiagnostics()]);
    await Promise.all([loadSessions(), loadStats()]);
  },
});

async function bindTauriSettingsEvent() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  await listen("open-settings", () => {
    settingsController.open();
  });
}

// ── URL 状态同步 ──────────────────────────────────────────────────────────────
function syncUrl() {
  const params = new URLSearchParams();
  if (state.filters.provider) params.set("provider", state.filters.provider);
  if (state.filters.source_kind)
    params.set("source_kind", state.filters.source_kind);
  if (state.filters.date) params.set("date", state.filters.date);
  if (state.filters.cwd) params.set("cwd", state.filters.cwd);
  if (state.filters.tag) params.set("tag", state.filters.tag);
  if (state.searchQuery) params.set("q", state.searchQuery);
  if (state.showArchived) params.set("show_archived", "1");
  if (state.showCodexArchived) params.set("show_codex_archived", "1");
  if (state.showHidden) params.set("show_hidden", "1");
  if (state.showRemoved) params.set("show_removed", "1");
  if (state.favoriteOnly) params.set("favorite", "1");
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
  state.filters.tag = params.get("tag") || "";
  state.searchQuery = params.get("q") || "";
  state.showArchived =
    params.get("show_archived") === "1" ||
    params.get("show_archived") === "true";
  state.showCodexArchived =
    params.get("show_codex_archived") === "1" ||
    params.get("show_codex_archived") === "true";
  state.showHidden =
    params.get("show_hidden") === "1" || params.get("show_hidden") === "true";
  state.showRemoved =
    params.get("show_removed") === "1" || params.get("show_removed") === "true";
  state.favoriteOnly =
    params.get("favorite") === "1" || params.get("favorite") === "true";
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

function compactSourceLabel(label) {
  const compact = String(label)
    .replace(/\s*\b(Code CLI|Code|CLI)\b\s*$/i, "")
    .trim();
  return compact || label;
}

function sourceKindLabel(sourceKind) {
  if (sourceKind === "codex_archived") return t("codexArchived");
  const source = state.facets?.sources?.find(
    (candidate) => candidate.kind === sourceKind
  );
  return source?.display_name || sourceKind;
}

function sourceAgentForKind(sourceKind) {
  if (sourceKind === "claude_code") return "claude";
  if (sourceKind === "codex_archived") return "codex";
  return sourceKind || "all";
}

function sourceDiagnosticCount(kinds) {
  const diagnostics = state.diagnostics?.sources || {};
  return kinds.reduce(
    (total, kind) => total + Number(diagnostics[kind]?.indexed_sessions || 0),
    0
  );
}

function renderSourceRail() {
  const activeAgent = sourceAgentForKind(state.filters.source_kind);
  const counts = new Map(
    SOURCE_RAIL_AGENTS.map(({ agent, kinds }) => [
      agent,
      sourceDiagnosticCount(kinds),
    ])
  );
  const total = Array.from(counts.values()).reduce(
    (sum, count) => sum + count,
    0
  );

  elements.sourceRailItems.forEach((button) => {
    const agent = button.dataset.sourceAgent;
    const active = agent === activeAgent;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    const count = button.querySelector("[data-source-count]");
    if (count) {
      count.textContent = state.diagnostics
        ? String(agent === "all" ? total : counts.get(agent) || 0)
        : "-";
    }
  });
}

function renderWorkspaceStatus() {
  renderSourceRail();

  if (elements.statusHealthButton && elements.statusHealthText) {
    const diagnostics = state.diagnostics?.sources;
    if (!diagnostics) {
      elements.statusHealthButton.dataset.state = "unavailable";
      elements.statusHealthText.textContent = t("scanHealthUnavailable");
    } else {
      const sourceCount = SOURCE_RAIL_AGENTS.filter(({ kinds }) =>
        kinds.some((kind) => diagnostics[kind]?.enabled)
      ).length;
      const indexedSessions = SOURCE_RAIL_AGENTS.reduce(
        (total, { kinds }) => total + sourceDiagnosticCount(kinds),
        0
      );
      const errorCount = Object.values(diagnostics).reduce(
        (total, diagnostic) => total + Number(diagnostic?.error_count || 0),
        0
      );
      const warning = errorCount > 0;
      elements.statusHealthButton.dataset.state = warning ? "warning" : "ready";
      elements.statusHealthText.textContent = t(
        warning ? "scanHealthWarning" : "scanHealthReady",
        {
          sources: sourceCount,
          sessions: indexedSessions,
          errors: errorCount,
        }
      );
    }
  }

  if (elements.statusFilterText) {
    const count = activeFilterEntries().length;
    elements.statusFilterText.textContent = count
      ? t("statusFilterCount", { n: count })
      : t("statusFilterNone");
  }
  if (elements.statusLanguage) {
    elements.statusLanguage.textContent = t(
      getLang() === "zh" ? "statusLanguageChinese" : "statusLanguageEnglish"
    );
  }
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
  fillSelect(elements.workspaceTagFilter, state.facets.workspace_tags || []);
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
  if (elements.workspaceTagFilter)
    elements.workspaceTagFilter.value = state.filters.tag;
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
  if (elements.favoriteOnlyToggle) {
    elements.favoriteOnlyToggle.checked = state.favoriteOnly;
  }
  renderProjectNav();
  renderWorkspaceStatus();
}

function rerenderLocalizedContent() {
  syncSchemeToggle();
  syncSourceRailToggle();
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
    syncSessionWorkspaceControls(state.currentDetail.summary);
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
  renderSavedFilters();
  updateBulkToolbar();
  if (state.stats) {
    renderStats(state.stats, elements);
  }
  renderWorkspaceStatus();
  maintenanceController.renderLocalized();
}

function syncSearchShortcut() {
  if (!elements.searchShortcut) return;
  const platform =
    navigator.userAgentData?.platform || navigator.platform || "";
  elements.searchShortcut.textContent = /^(mac|iphone|ipad|ipod)/i.test(
    platform
  )
    ? "⌘ K"
    : "Ctrl K";
}

function syncSchemeToggle() {
  if (!elements.schemeToggle) return;
  const key =
    getThemeState().resolvedScheme === "dark"
      ? "schemeToggleToLight"
      : "schemeToggleToDark";
  elements.schemeToggle.setAttribute("aria-label", t(key));
  elements.schemeToggle.title = t(key);
}

function defaultSourceRailCollapsed() {
  const stored = localStorage.getItem(SOURCE_RAIL_COLLAPSED_KEY);
  if (stored !== null) return stored === "true";
  return window.matchMedia(COMPACT_WORKSPACE_QUERY).matches;
}

function syncSourceRailToggle() {
  if (!elements.railToggle || !elements.appLayout) return;
  const expanded = !elements.appLayout.classList.contains("rail-collapsed");
  const label = t(expanded ? "hideSourceRail" : "showSourceRail");
  elements.railToggle.setAttribute("aria-expanded", String(expanded));
  elements.railToggle.setAttribute("aria-label", label);
  elements.railToggle.title = label;
}

function setSourceRailCollapsed(collapsed, { persist = false } = {}) {
  const compact = collapsed && !window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
  elements.appLayout?.classList.toggle("rail-collapsed", compact);
  if (persist) {
    localStorage.setItem(SOURCE_RAIL_COLLAPSED_KEY, String(collapsed));
  }
  syncSourceRailToggle();
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
  if (state.showArchived) {
    params.set("show_archived", "true");
  }
  if (state.showRemoved) {
    params.set("show_removed", "true");
  }
  if (state.favoriteOnly) {
    params.set("favorite", "true");
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
  return state.sessions;
}

async function clearFilterChip(type) {
  if (type in state.filters) {
    state.filters[type] = "";
  } else if (type === "search") {
    state.searchQuery = "";
  } else if (type === "showArchived") {
    state.showArchived = false;
  } else if (type === "showCodexArchived") {
    state.showCodexArchived = false;
  } else if (type === "showHidden") {
    state.showHidden = false;
  } else if (type === "showRemoved") {
    state.showRemoved = false;
  } else if (type === "favorite") {
    state.favoriteOnly = false;
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
  if (state.filters.tag) {
    entries.push({
      type: "tag",
      label: t("workspaceTagFilter"),
      value: state.filters.tag,
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
  if (state.favoriteOnly) {
    entries.push({
      type: "favorite",
      label: t("favoriteOnly"),
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
      session.model_provider || "unknown";
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

    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "session-archive-btn";
    const archiveLabel = archived ? t("unarchive") : t("archive");
    archiveBtn.title = archiveLabel;
    archiveBtn.setAttribute("aria-label", archiveLabel);
    archiveBtn.textContent = archived ? "↩" : "⊗";
    archiveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      archiveBtn.disabled = true;
      try {
        const next = !archived;
        await updateSessionWorkspace(session._key, { archived: next });
        await Promise.all([loadSessions(), loadStats(), loadFacets()]);
        announce(t(next ? "sessionArchived" : "sessionUnarchived"));
      } catch (error) {
        showError(`${t("workspaceSaveFailed")}: ${error.message}`);
      } finally {
        archiveBtn.disabled = false;
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
    updateBulkToolbar();
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
  updateBulkToolbar();
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
  const workspace = sessionWorkspace(summary);
  const tags = [
    { text: formatTimestamp(summary.timestamp), icon: "calendar", cls: "tag-time" },
    { text: summary.model_provider || "unknown", cls: "tag-provider" },
    {
      text: displaySourceLabel(summary),
      cls: "tag-source",
      sourceKind: sourceKindValue(summary),
    },
    { text: hiddenReasonLabel(summary), cls: "tag-hidden" },
    {
      text: workspace.removed === true ? t("removedSession") : "",
      cls: "tag-removed",
    },
    {
      text: workspace.favorite === true ? t("favorite") : "",
      cls: "tag-favorite",
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
  (workspace.tags || []).slice(0, 3).forEach((tag) => {
    const span = document.createElement("span");
    span.className = "detail-tag tag-workspace";
    span.textContent = tag;
    elements.detailTags.append(span);
  });
  if ((workspace.tags || []).length > 3) {
    const span = document.createElement("span");
    span.className = "detail-tag tag-workspace";
    span.textContent = `+${workspace.tags.length - 3}`;
    elements.detailTags.append(span);
  }
}

function syncSessionDeleteButton() {
  if (!elements.sessionDeleteBtn) return;
  const key = state.currentDetail?.summary?._key;
  const removed = key && sessionWorkspace(key).removed === true;
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
      ? sessionWorkspace(sessionKey).removed === true
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
  elements.deletePermanentBtn.classList.toggle(
    "hidden",
    state.currentDetail?.summary?.source_read_only === true
  );
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

async function restoreRemovedMessage(message) {
  const sessionKey = state.currentDetail?.summary?._key;
  if (!sessionKey || !message?._message_key) return;
  try {
    await updateMessageWorkspace(sessionKey, message._message_key, false);
    refreshDeletionViews();
    announce(t("contentRestored"));
  } catch (error) {
    showError(`${t("workspaceSaveFailed")}: ${error.message}`);
  }
}

async function applySoftDeletion() {
  if (!pendingDeletion) return;
  const { kind, sessionKey, messageKey, removed } = pendingDeletion;
  elements.deleteSoftBtn.disabled = true;
  try {
    if (kind === "session") {
      await updateSessionWorkspace(sessionKey, { removed: !removed });
      if (!removed && !state.showRemoved) {
        state.selectedSessionKey = null;
        state.currentDetail = null;
        showSelectSessionPlaceholder();
        syncUrl();
      }
    } else if (messageKey) {
      await updateMessageWorkspace(sessionKey, messageKey, !removed);
    }
    pendingDeletion = null;
    elements.deleteDialog.close();
    await Promise.all([loadSessions(), loadStats(), loadFacets()]);
    refreshDeletionViews();
    announce(t(removed ? "contentRestored" : "contentRemoved"));
  } catch (error) {
    elements.deleteDialogStatus.textContent = `${t("workspaceSaveFailed")}: ${error.message}`;
  } finally {
    elements.deleteSoftBtn.disabled = false;
  }
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
    const result = await fetchJson(url, { method: "POST", body });
    pendingDeletion = null;
    elements.deleteDialog.close();
    if (target.kind === "session") {
      state.selectedSessionKeys.delete(target.sessionKey);
      delete state.workspace.sessions[target.sessionKey];
      state.selectedSessionKey = null;
      state.currentDetail = null;
      showSelectSessionPlaceholder();
    }
    await loadFacets();
    await Promise.all([loadSessions(), loadStats()]);
    const backupPath = result?.backup?.path;
    const messageKey = backupPath
      ? target.kind === "session"
        ? "sessionDeletedWithBackup"
        : "messageDeletedWithBackup"
      : target.kind === "session"
        ? "sessionDeletedPermanently"
        : "messageDeletedPermanently";
    announce(t(messageKey, { path: backupPath || "" }));
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
    syncSessionWorkspaceControls(detail.summary);
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

async function loadWorkspaceDiagnostics() {
  const payload = await fetchJson("/api/settings");
  state.diagnostics = payload?.diagnostics || null;
  renderWorkspaceStatus();
}

async function loadCapabilities() {
  try {
    state.capabilities = await fetchJson("/api/capabilities");
  } catch (error) {
    console.error(error);
    state.capabilities = { codex_maintenance: { enabled: false } };
  }
  maintenanceController.setCapabilities(state.capabilities);
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

  const actions = document.createElement("div");
  actions.className = "workspace-load-actions";
  actions.append(retryButton);
  if (!isDesktopRuntimeUnavailable(error)) {
    const settingsButton = document.createElement("button");
    settingsButton.className = "ghost-button";
    settingsButton.type = "button";
    settingsButton.textContent = t("openSettingsForRecovery");
    settingsButton.addEventListener("click", () => {
      void settingsController.open("sources");
    });
    actions.append(settingsButton);
  }

  stateCard.append(heading, copy);
  if (!isDesktopRuntimeUnavailable(error)) {
    const detail = document.createElement("p");
    detail.className = "workspace-load-detail";
    detail.textContent = message;
    stateCard.append(detail);
  }
  stateCard.append(actions);
  elements.sessionList.replaceChildren(stateCard);
  elements.activeFilterBar?.replaceChildren();
  elements.sessionCount.textContent = "-";
  elements.sessionRoot.textContent = t("workspaceUnavailable");
  elements.sessionRoot.removeAttribute("title");
  renderWorkspaceStatus();
}

function openRecoverySettingsOnce() {
  if (
    state.capabilities?.recovery_required !== true ||
    state.recoverySettingsOpened
  ) {
    return;
  }
  state.recoverySettingsOpened = true;
  void settingsController.open("sources");
}

async function bindTauriSessionEventsOnce() {
  if (state.tauriEventsBound) return;
  try {
    await bindTauriSessionEvents({
      refresh: async () => {
        await Promise.all([loadFacets(), loadWorkspaceDiagnostics()]);
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
    await loadWorkspaceState();
    await Promise.all([
      loadFacets(),
      loadCapabilities(),
      loadWorkspaceDiagnostics(),
    ]);
    const sessionsLoaded = await loadSessions({ reportError: false });
    if (!sessionsLoaded) {
      throw state.lastSessionError || new Error(t("loadListFailed"));
    }
    state._initialized = true;
    state.workspaceLoadError = null;
    void loadStats();
    await bindTauriSessionEventsOnce();
    openRecoverySettingsOnce();
    return true;
  } catch (error) {
    console.error(error);
    state._initialized = false;
    renderWorkspaceLoadFailure(error);
    openRecoverySettingsOnce();
    return false;
  }
}

async function returnHome() {
  detailRequestGate.cancel();
  state.filters = {
    provider: "",
    source_kind: "",
    date: "",
    cwd: "",
    tag: "",
  };
  state.searchQuery = "";
  state.showArchived = false;
  state.showCodexArchived = false;
  state.showHidden = false;
  state.showRemoved = false;
  state.favoriteOnly = false;
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

function isEditableShortcutTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest("input, textarea, select, [contenteditable='true']")
  );
}

function sessionKeyboardItems() {
  return Array.from(elements.sessionList.querySelectorAll(".session-item"));
}

function moveSessionSelection(direction) {
  const items = sessionKeyboardItems();
  if (!items.length) return;
  const focused = document.activeElement?.closest?.(".session-item");
  const selected = items.find((item) => item.classList.contains("active"));
  const current = focused || selected;
  const index = items.indexOf(current);
  const nextIndex =
    direction > 0
      ? index < items.length - 1
        ? index + 1
        : 0
      : index > 0
        ? index - 1
        : items.length - 1;
  const next = items[nextIndex];
  next.focus();
  next.scrollIntoView({ block: "nearest" });
  const sessionKey = next.dataset.sessionKey;
  if (sessionKey) selectSession(sessionKey, next);
}

function closeTopDialogFromKeyboard() {
  const dialogs = Array.from(document.querySelectorAll("dialog[open]"));
  const dialog = dialogs.at(-1);
  if (!dialog) return false;
  const cancelEvent = new Event("cancel", { cancelable: true });
  if (dialog.dispatchEvent(cancelEvent)) dialog.close();
  return true;
}

function openFocusedSession() {
  const item = document.activeElement?.closest?.(".session-item");
  const sessionKey = item?.dataset.sessionKey;
  if (!item || !sessionKey) return false;
  selectSession(sessionKey, item);
  if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
    scrollToWorkspaceSection(document.querySelector("#detail-panel"));
  }
  return true;
}

async function initialize() {
  restoreFromUrl();
  maintenanceController.bind();
  setSourceRailCollapsed(defaultSourceRailCollapsed());
  syncInspectorLayout();
  syncSchemeToggle();
  elements.schemeToggle?.addEventListener("click", toggleScheme);
  document.addEventListener("allsessions:themechange", syncSchemeToggle);
  elements.railToggle?.addEventListener("click", () => {
    const collapsed = !elements.appLayout?.classList.contains("rail-collapsed");
    setSourceRailCollapsed(collapsed, { persist: true });
  });
  window.matchMedia(MOBILE_LAYOUT_QUERY).addEventListener("change", () => {
    setSourceRailCollapsed(defaultSourceRailCollapsed());
  });
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
  elements.sourceRailItems.forEach((button) => {
    button.addEventListener("click", () => {
      setSourceKindFilter(button.dataset.sourceKind || "").catch((error) => {
        console.error(error);
        showError(`${t("loadListFailed")}: ${error.message}`);
      });
    });
  });
  elements.statusHealthButton?.addEventListener("click", () => {
    void settingsController.open("sources");
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

  elements.workspaceTagFilter?.addEventListener("change", async (event) => {
    state.filters.tag = event.target.value;
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  elements.resetFilters?.addEventListener("click", async () => {
    state.filters = {
      provider: "",
      source_kind: "",
      date: "",
      cwd: "",
      tag: "",
    };
    state.searchQuery = "";
    state.showArchived = false;
    state.showCodexArchived = false;
    state.showHidden = false;
    state.showRemoved = false;
    state.favoriteOnly = false;
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
        await Promise.all([loadFacets(), loadWorkspaceDiagnostics()]);
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
    elements.showArchivedToggle.addEventListener("change", async () => {
      state.showArchived = elements.showArchivedToggle.checked;
      syncUrl();
      await Promise.all([loadSessions(), loadStats()]);
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
    elements.showRemovedToggle.addEventListener("change", async () => {
      state.showRemoved = elements.showRemovedToggle.checked;
      syncUrl();
      await Promise.all([loadSessions(), loadStats()]);
    });
  }

  elements.favoriteOnlyToggle?.addEventListener("change", async () => {
    state.favoriteOnly = elements.favoriteOnlyToggle.checked;
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  elements.saveFilterBtn?.addEventListener("click", saveCurrentFilter);
  elements.savedFilterName?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveCurrentFilter();
    }
  });

  elements.selectVisibleBtn?.addEventListener("click", () => {
    const visible = visibleSessions();
    const allSelected =
      visible.length > 0 &&
      visible.every((session) => state.selectedSessionKeys.has(session._key));
    visible.forEach((session) =>
      setSessionSelected(session._key, !allSelected)
    );
  });
  elements.clearSelectionBtn?.addEventListener("click", () => {
    state.selectedSessionKeys.clear();
    renderSessionList();
  });
  elements.bulkExportBtn?.addEventListener("click", exportSelectedSessions);

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
      if (state.currentDetail) {
        exportSessionMarkdown(state.currentDetail, {
          redact: elements.exportRedactToggle?.checked === true,
        });
      }
    });
  }

  if (elements.exportJsonBtn) {
    elements.exportJsonBtn.addEventListener("click", () => {
      if (state.currentDetail) {
        exportSessionJson(state.currentDetail, {
          redact: elements.exportRedactToggle?.checked === true,
        });
      }
    });
  }

  elements.sessionFavoriteBtn?.addEventListener("click", async () => {
    const key = state.currentDetail?.summary?._key;
    if (!key) return;
    elements.sessionFavoriteBtn.disabled = true;
    try {
      const favorite = sessionWorkspace(key).favorite !== true;
      await updateSessionWorkspace(key, { favorite });
      syncSessionWorkspaceControls(state.currentDetail.summary);
      renderDetailTags(state.currentDetail.summary);
      await Promise.all([loadSessions(), loadStats(), loadFacets()]);
      announce(t(favorite ? "sessionFavorited" : "sessionUnfavorited"));
    } catch (error) {
      showError(`${t("workspaceSaveFailed")}: ${error.message}`);
    } finally {
      elements.sessionFavoriteBtn.disabled = false;
    }
  });

  elements.saveSessionWorkspaceBtn?.addEventListener("click", async () => {
    const key = state.currentDetail?.summary?._key;
    if (!key) return;
    elements.saveSessionWorkspaceBtn.disabled = true;
    try {
      await updateSessionWorkspace(key, {
        tags: parseWorkspaceTags(elements.sessionTagsInput?.value || ""),
        note: elements.sessionNoteInput?.value || "",
      });
      syncSessionWorkspaceControls(state.currentDetail.summary);
      renderDetailTags(state.currentDetail.summary);
      renderSessionList();
      await loadFacets();
      announce(t("workspaceSaved"));
      if (elements.sessionOrganizeMenu)
        elements.sessionOrganizeMenu.open = false;
    } catch (error) {
      showError(`${t("workspaceSaveFailed")}: ${error.message}`);
    } finally {
      elements.saveSessionWorkspaceBtn.disabled = false;
    }
  });
  elements.revealSourceBtn?.addEventListener("click", () => {
    void revealCurrentPath("source");
  });
  elements.revealProjectBtn?.addEventListener("click", () => {
    void revealCurrentPath("project");
  });

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
    if (event.key === "Escape") {
      if (closeTopDialogFromKeyboard()) {
        event.preventDefault();
        return;
      }
      if (
        elements.propsContent
          ?.closest(".props-panel")
          ?.classList.contains("is-open")
      ) {
        event.preventDefault();
        setInspectorOpen(false);
        elements.sessionInspectorToggle?.focus();
      }
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      elements.searchInput?.focus();
      elements.searchInput?.select();
      return;
    }

    if (
      isEditableShortcutTarget(event.target) ||
      document.querySelector("dialog[open]")
    ) {
      return;
    }

    const view = { 1: "list", 2: "stats", 3: "tools" }[event.key];
    if (view && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      activateWorkspaceView(view).catch((error) => {
        console.error(error);
        showError(error.message);
      });
      return;
    }

    const activeElement = document.activeElement;
    const arrowFromList =
      elements.sessionList.contains(activeElement) ||
      activeElement === document.body;
    const moveDown = event.key === "j" || event.key === "ArrowDown";
    const moveUp = event.key === "k" || event.key === "ArrowUp";
    if (
      (moveDown || moveUp) &&
      (!event.key.startsWith("Arrow") || arrowFromList)
    ) {
      event.preventDefault();
      if (state.activeView !== "list") {
        void activateWorkspaceView("list");
      }
      moveSessionSelection(moveDown ? 1 : -1);
      return;
    }

    if (event.key === "Enter" && openFocusedSession()) {
      event.preventDefault();
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

  updateStaticI18n();
  document.documentElement.lang = getLang() === "zh" ? "zh-CN" : "en";
  syncSearchShortcut();
  maintenanceController.renderLocalized();

  settingsController.bind();
  await bindTauriSettingsEvent();

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
