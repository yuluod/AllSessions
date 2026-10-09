// 共享状态与工具:常量、state/elements 快照、请求门闩、来源标签与全局提示。
import { t, translateBackendError } from "../i18n.js";
import { fetchJson as requestJson } from "../api-client.js";
import { createLatestRequestGate } from "../async-coordinator.js";

export const PAGE_LIMIT = 50;
export const MAX_BULK_EXPORT_SESSIONS = 20;
export const BULK_EXPORT_CONCURRENCY = 4;
export const PROJECT_PREVIEW_LIMIT = 12;
export const MOBILE_LAYOUT_QUERY = "(max-width: 760px)";
export const INSPECTOR_DRAWER_QUERY = "(max-width: 1640px)";
export const COMPACT_WORKSPACE_QUERY =
  "(min-width: 761px) and (max-width: 1640px)";
export const SOURCE_RAIL_COLLAPSED_KEY = "allsessions_source_rail_collapsed";
export const SOURCE_RAIL_AGENTS = [
  { agent: "codex", kinds: ["codex", "codex_archived"] },
  { agent: "claude", kinds: ["claude"] },
  { agent: "gemini", kinds: ["gemini"] },
  { agent: "pi", kinds: ["pi"] },
  { agent: "kimi", kinds: ["kimi"] },
  { agent: "opencode", kinds: ["opencode"] },
  { agent: "kilo", kinds: ["kilo"] },
  { agent: "zcode", kinds: ["zcode"] },
  { agent: "cursor", kinds: ["cursor"] },
  { agent: "devin", kinds: ["devin"] },
  { agent: "copilot", kinds: ["copilot", "vscode_copilot"] },
  { agent: "hermes", kinds: ["hermes"] },
];
export const ARCHIVE_KEY = "codex_viewer_archived_sessions";
export const REMOVED_SESSIONS_KEY = "allsessions_removed_sessions";
export const REMOVED_MESSAGES_KEY = "allsessions_removed_messages";
export const sessionRequestGate = createLatestRequestGate();
export const detailRequestGate = createLatestRequestGate();
export const statsRequestGate = createLatestRequestGate();

export const state = {
  capabilities: null,
  diagnostics: null,
  facets: null,
  stats: null,
  sessions: [],
  scanning: false,
  selectedSessionKey: null,
  activeTab: "conversation",
  hasMore: false,
  nextCursor: null,
  searchQuery: "",
  searchSort: "relevance",
  selectedSearchHit: null,
  showArchived: false,
  showCodexArchived: false,
  showHidden: false,
  showRemoved: false,
  favoriteOnly: false,
  showAllProjects: false,
  currentDetail: null,
  detailQuery: "",
  showTools: true,
  showContext: true,
  conversationDesc: false,
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

export function isMessageRemoved(message) {
  return message?._removed === true;
}

export function sessionWorkspace(sessionOrKey) {
  const key =
    typeof sessionOrKey === "string" ? sessionOrKey : sessionOrKey?._key;
  return state.workspace.sessions?.[key] || sessionOrKey?.workspace || {};
}
export function isCodexArchivedSession(session) {
  return session?.archived === true && session.archive_source === "codex";
}
export function scrollToWorkspaceSection(element) {
  if (!element) return;
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;
  element.scrollIntoView({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "start",
  });
}
export function isHiddenSession(session) {
  return session?.hidden === true;
}

export function hiddenReasonLabel(session) {
  if (!isHiddenSession(session)) {
    return "";
  }
  if (session.hidden_reason === "subagent") {
    return t("hiddenSubagent");
  }
  return session.hidden_reason || t("hiddenSession");
}

export function visibilityLabel(session) {
  if (isCodexArchivedSession(session)) {
    return t("codexArchived");
  }
  return hiddenReasonLabel(session) || t("visibleSession");
}

export const elements = {
  appLayout: document.querySelector(".app-layout"),
  homeLink: document.querySelector("#home-link"),
  railToggle: document.querySelector("#rail-toggle"),
  sidebarLeft: document.querySelector(".sidebar-left"),
  sidebarFilters: document.querySelector("#sidebar-filters"),
  projectNav: document.querySelector(".project-nav"),
  sessionRoot: document.querySelector("#session-root"),
  sessionCount: document.querySelector("#session-count"),
  sourceRailItems: Array.from(
    document.querySelectorAll("#source-rail-list [data-source-kind]")
  ),
  providerFilter: document.querySelector("#provider-filter"),
  dateFilter: document.querySelector("#date-filter"),
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
  statusHealthIssues: document.querySelector("#status-health-issues"),
  indexProgressBar: document.querySelector("#index-progress"),
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
  conversationDescToggle: document.querySelector("#conversation-desc-toggle"),
  messageNavInlineList: document.querySelector("#message-nav-inline-list"),
  conversationList: document.querySelector("#conversation-list"),
  rawEvents: document.querySelector("#raw-events"),
  conversationTab: document.querySelector("#conversation-tab"),
  rawTab: document.querySelector("#raw-tab"),
  tabButtons: Array.from(document.querySelectorAll(".tab-button")),
  exportMdBtn: document.querySelector("#export-md-btn"),
  exportJsonBtn: document.querySelector("#export-json-btn"),
  exportRedactToggle: document.querySelector("#export-redact-toggle"),
  sessionArchiveBtn: document.querySelector("#session-archive-btn"),
  sessionFavoriteBtn: document.querySelector("#session-favorite-btn"),
  sessionOrganizeMenu: document.querySelector("#session-organize-menu"),
  sessionTagsInput: document.querySelector("#session-tags-input"),
  sessionNoteInput: document.querySelector("#session-note-input"),
  saveSessionWorkspaceBtn: document.querySelector(
    "#save-session-workspace-btn"
  ),
  revealSourceBtn: document.querySelector("#reveal-source-btn"),
  revealProjectBtn: document.querySelector("#reveal-project-btn"),
  resumeSessionBtn: document.querySelector("#resume-session-btn"),
  statsDashboard: document.querySelector("#stats-dashboard"),
  statsMetrics: document.querySelector("#stats-metrics"),
  statsGrid: document.querySelector("#stats-grid"),
  trendChartBody: document.querySelector("#trend-chart-body"),
  tokenHeatmapBody: document.querySelector("#token-heatmap-body"),
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
  settingsTerminalApp: document.querySelector("#settings-terminal-app"),
  settingsTerminalCustomPick: document.querySelector(
    "#settings-terminal-custom-pick"
  ),
  settingsSourceOverview: document.querySelector("#settings-source-overview"),
  settingsSources: document.querySelector("#settings-sources"),
  settingsRecovery: document.querySelector("#settings-recovery"),
  settingsRecoveryMessage: document.querySelector("#settings-recovery-message"),
  settingsDiagnosticsMeta: document.querySelector("#settings-diagnostics-meta"),
  settingsCopyDiagnostics: document.querySelector("#settings-copy-diagnostics"),
  settingsRescan: document.querySelector("#settings-rescan"),
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
  archiveDialog: document.querySelector("#archive-confirm-dialog"),
  archiveDialogClose: document.querySelector("#archive-dialog-close"),
  archiveDialogCancel: document.querySelector("#archive-dialog-cancel"),
  archiveDialogConfirm: document.querySelector("#archive-dialog-confirm"),
  archiveDialogStatus: document.querySelector("#archive-dialog-status"),
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
export function displaySourceLabel(summary) {
  if (isCodexArchivedSession(summary)) {
    return t("codexArchived");
  }
  return summary.display_source || summary.source_kind || "";
}

export function sourceKindValue(summary) {
  if (isCodexArchivedSession(summary)) return "codex_archived";
  return summary?.source_kind || "unknown";
}

export function resumeCommandForKind(kind, sessionId) {
  switch (kind) {
    case "claude_code":
      return `claude --resume ${sessionId}`;
    case "codex":
    case "codex_archived":
      return `codex resume ${sessionId}`;
    case "gemini":
      return `gemini --resume ${sessionId}`;
    case "pi":
      return `pi --session ${sessionId}`;
    case "kimi":
      return `kimi --resume ${sessionId}`;
    case "opencode":
      return `opencode --session ${sessionId}`;
    case "zcode":
      return `zcode --resume ${sessionId}`;
    case "copilot":
      return `copilot --resume ${sessionId}`;
    case "hermes":
      return `hermes --resume ${sessionId}`;
    default:
      return null;
  }
}

export function compactSourceLabel(label) {
  const compact = String(label)
    .replace(/\s*\b(Code CLI|Code|CLI)\b\s*$/i, "")
    .trim();
  return compact || label;
}

export function sourceKindLabel(sourceKind) {
  if (sourceKind === "codex_archived") return t("codexArchived");
  const source = state.facets?.sources?.find(
    (candidate) => candidate.kind === sourceKind
  );
  return source?.display_name || sourceKind;
}

export function sourceAgentForKind(sourceKind) {
  if (sourceKind === "claude_code") return "claude";
  if (sourceKind === "codex_archived") return "codex";
  if (sourceKind === "vscode_copilot") return "copilot";
  return sourceKind || "all";
}

export function sourceDiagnosticCount(kinds) {
  const diagnostics = state.diagnostics?.sources || {};
  return kinds.reduce(
    (total, kind) => total + Number(diagnostics[kind]?.indexed_sessions || 0),
    0
  );
}

export async function fetchJson(url, options) {
  return requestJson(url, options, {
    formatError: (status) => t("requestFailed", { status }),
    translateCode: translateBackendError,
  });
}
export function visibleSessions() {
  return state.sessions;
}
export function announce(message) {
  const ariaLive = document.querySelector("#aria-live");
  if (ariaLive) ariaLive.textContent = message;
}
let errorTimer = null;
export function showError(message) {
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
