// 状态栏与来源栏:来源计数、扫描健康状态、快捷键提示与来源栏折叠。
import { getLang, t } from "../i18n.js";
import { getThemeState } from "../theme-manager.js";
import {
  COMPACT_WORKSPACE_QUERY,
  MOBILE_LAYOUT_QUERY,
  SOURCE_RAIL_AGENTS,
  SOURCE_RAIL_COLLAPSED_KEY,
  elements,
  sourceAgentForKind,
  sourceDiagnosticCount,
  state,
} from "./shared.js";
import { activeFilterEntries } from "./filters.js";

export function renderSourceRail() {
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
    const isEmptySource =
      Boolean(state.diagnostics) &&
      agent !== "all" &&
      !active &&
      !Number(counts.get(agent) || 0);
    button.classList.toggle("is-empty", isEmptySource);
  });
}

export function renderWorkspaceStatus() {
  renderSourceRail();

  if (elements.statusHealthButton && elements.statusHealthText) {
    const diagnostics = state.diagnostics?.sources;
    const indexing = state.indexProgress;
    const issues = elements.statusHealthIssues;
    if (issues) issues.hidden = true;
    elements.statusHealthButton.title = indexing?.error || "";
    const progress = elements.indexProgressBar;
    if (progress) {
      progress.hidden = indexing?.phase !== "indexing";
      progress.max = Math.max(1, indexing?.total || 0);
      progress.value = indexing?.processed || 0;
      progress.setAttribute("aria-label", t("indexProgressLabel"));
    }
    if (indexing?.phase === "scanning" || indexing?.phase === "indexing") {
      elements.statusHealthButton.dataset.state = "loading";
      elements.statusHealthText.textContent =
        indexing.phase === "scanning"
          ? t("scanningSessions")
          : t("indexProgress", indexing);
    } else if (indexing?.phase === "error") {
      elements.statusHealthButton.dataset.state = "warning";
      elements.statusHealthText.textContent = t("indexProgressError");
    } else if (indexing?.phase === "unavailable") {
      elements.statusHealthButton.dataset.state = "unavailable";
      elements.statusHealthText.textContent = t("indexProgressUnavailable");
    } else if (!diagnostics) {
      elements.statusHealthButton.dataset.state = "unavailable";
      elements.statusHealthText.textContent = t("scanHealthUnavailable");
    } else {
      const indexedSessions = SOURCE_RAIL_AGENTS.reduce(
        (total, { kinds }) => total + sourceDiagnosticCount(kinds),
        0
      );
      const errorCount = Object.values(diagnostics).reduce(
        (total, diagnostic) => total + Number(diagnostic?.error_count || 0),
        0
      );
      elements.statusHealthButton.dataset.state = errorCount
        ? "partial"
        : "ready";
      elements.statusHealthText.textContent = t("scanHealthReady", {
        sessions: indexedSessions,
      });
      if (issues && errorCount > 0) {
        issues.hidden = false;
        issues.dataset.kind = "error";
        issues.textContent = t("scanHealthWarning", { errors: errorCount });
        elements.statusHealthButton.title = t("scanHealthViewIssues");
      }
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
export function syncShortcutHints() {
  const platform =
    navigator.userAgentData?.platform || navigator.platform || "";
  const isMac = /^(mac|iphone|ipad|ipod)/i.test(platform);
  if (elements.searchShortcut) {
    elements.searchShortcut.textContent = isMac ? "⌘ K" : "Ctrl K";
  }
  if (elements.settingsToggle) {
    const hint = isMac ? "⌘," : "Ctrl+,";
    elements.settingsToggle.title = `${t("settings")} (${hint})`;
  }
}

export function syncSchemeToggle() {
  if (!elements.schemeToggle) return;
  const key =
    getThemeState().resolvedScheme === "dark"
      ? "schemeToggleToLight"
      : "schemeToggleToDark";
  elements.schemeToggle.setAttribute("aria-label", t(key));
  elements.schemeToggle.title = t(key);
}

export function defaultSourceRailCollapsed() {
  const stored = localStorage.getItem(SOURCE_RAIL_COLLAPSED_KEY);
  if (stored !== null) return stored === "true";
  return window.matchMedia(COMPACT_WORKSPACE_QUERY).matches;
}

export function syncSourceRailToggle() {
  if (!elements.railToggle || !elements.appLayout) return;
  const expanded = !elements.appLayout.classList.contains("rail-collapsed");
  const label = t(expanded ? "hideSourceRail" : "showSourceRail");
  elements.railToggle.setAttribute("aria-expanded", String(expanded));
  elements.railToggle.setAttribute("aria-label", label);
  elements.railToggle.title = label;
}

export function setSourceRailCollapsed(collapsed, { persist = false } = {}) {
  const compact = collapsed && !window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
  elements.appLayout?.classList.toggle("rail-collapsed", compact);
  if (persist) {
    localStorage.setItem(SOURCE_RAIL_COLLAPSED_KEY, String(collapsed));
  }
  syncSourceRailToggle();
}
