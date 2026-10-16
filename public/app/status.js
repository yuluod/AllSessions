import { sourceRailItemState } from "../source-rail.js";
// 状态栏与来源栏:来源计数、扫描健康状态与快捷键提示。
import { getLang, t } from "../i18n.js";
import { getThemeState } from "../theme-manager.js";
import {
  SOURCE_RAIL_AGENTS,
  elements,
  sourceDiagnosticCount,
  state,
} from "./shared.js";
import { activeFilterEntries } from "./filters.js";

export function renderSourceRail() {
  // 项目筛选生效时，来源计数改为该项目内部的来源分布。
  const project = state.filters.cwd
    ? (state.facets?.projects || []).find(
        (project) => project.path === state.filters.cwd
      )
    : null;
  const projectCounts = project?.source_counts || null;
  elements.sourceRailItems.forEach((button) => {
    const item = sourceRailItemState(
      button.dataset.sourceKind,
      state.filters.source_kind,
      state.diagnostics,
      projectCounts
    );
    button.classList.toggle("active", item.active);
    button.setAttribute("aria-pressed", item.active ? "true" : "false");
    const count = button.querySelector("[data-source-count]");
    if (count) count.textContent = item.count;
    button.classList.toggle("is-empty", item.empty);
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
    const count = activeFilterEntries().filter(
      (entry) => state.activeView !== "stats" || entry.type !== "search"
    ).length;
    elements.statusFilterText.textContent = count
      ? count === 1
        ? t("statusFilterCountOne", { n: count })
        : t("statusFilterCount", { n: count })
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
  const { scheme } = getThemeState();
  const keys = {
    light: "schemeLight",
    dark: "schemeDark",
    system: "schemeSystem",
  };
  elements.schemeOptions.forEach((button) => {
    const mode = button.dataset.schemeOption;
    button.setAttribute("aria-pressed", String(mode === scheme));
    button.setAttribute("aria-label", t(keys[mode]));
    button.title = t(keys[mode]);
  });
}
