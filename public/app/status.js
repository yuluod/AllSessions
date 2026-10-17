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
  // 项目筛选生效时：主数字为项目内分布，全局总数弱化跟在后面；
  // 组头提示同步切换为项目名，让数字的含义变化显式可见。
  const project = state.filters.cwd
    ? (state.facets?.projects || []).find(
        (project) => project.path === state.filters.cwd
      )
    : null;
  const projectCounts = project?.source_counts || null;
  if (elements.sourceRailHint) {
    elements.sourceRailHint.textContent = project
      ? t("sourceRailProjectHint", { name: project.name })
      : t("sourceRailHint");
  }
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
    if (count) {
      // 全局总数嵌在数字元素内部（行内 span），不能作为独立 grid 子元素，
      // 否则会被三列布局挤到下一行。
      const globalCount = sourceRailItemState(
        button.dataset.sourceKind,
        "",
        state.diagnostics
      ).count;
      const showGlobal =
        Boolean(projectCounts) &&
        globalCount !== "-" &&
        globalCount !== item.count;
      const changed = (count.firstChild?.textContent ?? "") !== item.count;
      if (changed) count.classList.add("count-flash");
      count.classList.toggle("count-zero", item.count === "0");
      const globalEl = showGlobal
        ? Object.assign(document.createElement("span"), {
            className: "source-count-global",
            textContent: ` / ${globalCount}`,
          })
        : null;
      count.replaceChildren(
        document.createTextNode(item.count),
        ...(globalEl ? [globalEl] : [])
      );
      if (changed) {
        requestAnimationFrame(() => count.classList.remove("count-flash"));
      }
    }
    button.classList.toggle("is-empty", item.empty);
    // 展开态的分组排列：非空（及选中的）来源在前、空来源在后；
    // 组内保持固定顺序，避免切换项目时行序跳动。用 order 实现，不搬 DOM。
    button.style.order = item.empty && !item.active ? 1 : 0;
    // 收起态下零会话行直接隐藏，只留“其他来源 · N”入口；展开态置灰显示。
    button.classList.toggle(
      "is-collapsed-hidden",
      item.empty && !messageNavSourcesExpanded()
    );
  });
  updateSourceRailMore();
}

// “其他来源”折叠开关状态（持久化；默认收起，常用来源只占必需的行数）。
function messageNavSourcesExpanded() {
  return localStorage.getItem("allsessions_sources_expanded") === "1";
}

function updateSourceRailMore() {
  const tree = elements.sourceRailList;
  if (!tree) return;
  let more = tree.querySelector(".source-tree__more");
  if (!more) {
    more = document.createElement("button");
    more.type = "button";
    more.className = "source-tree__more";
    more.style.order = "2";
    more.addEventListener("click", () => {
      const expanded = messageNavSourcesExpanded();
      localStorage.setItem(
        "allsessions_sources_expanded",
        expanded ? "0" : "1"
      );
      renderSourceRail();
    });
    const caret = document.createElement("span");
    caret.className = "more-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "⌄";
    const label = document.createElement("span");
    label.className = "more-label";
    label.dataset.i18n = "sourceRailMore";
    const count = document.createElement("strong");
    count.className = "more-count";
    more.append(caret, label, count);
    tree.append(more);
  }
  const hiddenCount = elements.sourceRailItems.filter(
    (button) => button.classList.contains("is-empty")
  ).length;
  const expanded = messageNavSourcesExpanded();
  tree.classList.toggle("expanded", expanded);
  more.hidden = hiddenCount === 0 && !expanded;
  more.setAttribute("aria-expanded", expanded ? "true" : "false");
  more.querySelector(".more-label").textContent = t("sourceRailMore");
  more.querySelector(".more-count").textContent = String(hiddenCount);
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
