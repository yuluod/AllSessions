// 筛选与查询:筛选状态、URL 同步、查询串构造、活动筛选 chips 与项目导航。
import { t } from "../i18n.js";
import { projectNavEntries } from "../project-nav.js";
import { cwdParts, fillSelect } from "../session-format.js";
import {
  PAGE_LIMIT,
  PROJECT_PREVIEW_LIMIT,
  elements,
  showError,
  sourceKindLabel,
  state,
} from "./shared.js";
import { loadSessions, loadStats } from "./data.js";
import { renderWorkspaceStatus } from "./status.js";

export function currentFilterValue() {
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

export function applyFilterValue(filter = {}) {
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
// ── URL 状态同步 ──────────────────────────────────────────────────────────────
export function syncUrl() {
  const params = new URLSearchParams();
  if (state.filters.provider) params.set("provider", state.filters.provider);
  if (state.filters.source_kind)
    params.set("source_kind", state.filters.source_kind);
  if (state.filters.date) params.set("date", state.filters.date);
  if (state.filters.cwd) params.set("cwd", state.filters.cwd);
  if (state.filters.tag) params.set("tag", state.filters.tag);
  if (state.searchQuery) params.set("q", state.searchQuery);
  if (state.searchRole) params.set("role", state.searchRole);
  if (state.searchTool) params.set("tool", state.searchTool);
  if (state.searchRegex) params.set("regex", "1");
  if (state.searchFrom) params.set("from", state.searchFrom);
  if (state.searchTo) params.set("to", state.searchTo);
  if (state.showArchived) params.set("show_archived", "1");
  if (state.showCodexArchived) params.set("show_codex_archived", "1");
  if (state.showHidden) params.set("show_hidden", "1");
  if (state.showRemoved) params.set("show_removed", "1");
  if (state.favoriteOnly) params.set("favorite", "1");
  if (state.selectedSessionKey) params.set("session", state.selectedSessionKey);
  const search = params.toString();
  history.replaceState(null, "", search ? `?${search}` : location.pathname);
}

export function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  state.filters.provider = params.get("provider") || "";
  state.filters.source_kind = params.get("source_kind") || "";
  state.filters.date = params.get("date") || "";
  state.filters.cwd = params.get("cwd") || "";
  state.filters.tag = params.get("tag") || "";
  state.searchQuery = params.get("q") || "";
  state.searchRole = params.get("role") || "";
  state.searchTool = params.get("tool") || "";
  state.searchRegex = params.get("regex") === "1";
  state.searchFrom = params.get("from") || "";
  state.searchTo = params.get("to") || "";
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
export async function setSourceKindFilter(sourceKind) {
  if (state.filters.source_kind === sourceKind) return;
  state.filters.source_kind = sourceKind;
  syncFilterControls();
  syncUrl();
  await Promise.all([loadSessions(), loadStats()]);
}

export async function setCwdFilter(cwd) {
  state.filters.cwd = cwd;
  syncFilterControls();
  syncUrl();
  await Promise.all([loadSessions(), loadStats()]);
}
// 组头提示优先取来源栏按钮的现有文案，避免依赖 facets 中可能缺失的来源显示名。
function sourceFilterLabel(sourceKind) {
  const button = elements.sourceRailItems.find(
    (item) => item.dataset.sourceKind === sourceKind
  );
  return (
    button?.querySelector("span:not(.source-tree__dot)")?.textContent?.trim() ||
    sourceKindLabel(sourceKind)
  );
}

export function renderProjectNav() {
  if (!elements.projectList) return;

  const sourceKind = state.filters.source_kind;
  // 来源筛选决定项目列表：只保留该来源有会话的项目，计数换成该来源的会话数。
  const entries = projectNavEntries(
    state.facets?.projects || [],
    sourceKind,
    state.filters.cwd
  );
  if (elements.projectNavHint) {
    elements.projectNavHint.textContent = sourceKind
      ? t("projectNavSourceHint", { name: sourceFilterLabel(sourceKind) })
      : t("recentProjects");
  }
  elements.projectList.innerHTML = "";
  elements.projectNav?.querySelector(".project-more")?.remove();

  const allButton = document.createElement("button");
  allButton.className = "project-item";
  allButton.type = "button";
  allButton.classList.toggle("active", !state.filters.cwd);
  const allName = document.createElement("span");
  allName.className = "project-name";
  allName.textContent = t("allProjects");
  const allMeta = document.createElement("span");
  allMeta.className = "project-meta";
  allMeta.textContent = t("projectCount", { n: entries.length });
  allButton.append(allName, allMeta);
  allButton.addEventListener("click", () => {
    setCwdFilter("").catch((error) => {
      console.error(error);
      showError(`${t("loadListFailed")}: ${error.message}`);
    });
  });
  elements.projectList.append(allButton);

  if (sourceKind && !entries.length) {
    const empty = document.createElement("p");
    empty.className = "project-empty";
    empty.textContent = t("projectSourceEmpty");
    elements.projectList.append(empty);
  }

  const visibleProjects = state.showAllProjects
    ? entries
    : entries.slice(0, PROJECT_PREVIEW_LIMIT);
  visibleProjects.forEach(({ project, count }) => {
    const button = document.createElement("button");
    button.className = "project-item";
    button.type = "button";
    button.classList.toggle("active", state.filters.cwd === project.path);
    button.setAttribute(
      "aria-label",
      `${project.name || project.path} · ${t("projectSessionCount", { n: count })} · ${project.path}`
    );

    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = project.name || project.path;

    const meta = document.createElement("strong");
    meta.className = "project-meta";
    meta.textContent = String(count);
    meta.classList.toggle("count-zero", count === 0);
    meta.setAttribute("aria-hidden", "true");

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

  if (entries.length > PROJECT_PREVIEW_LIMIT) {
    // 与来源树「其他来源」披露行同构：caret + 标签，caret 随展开旋转。
    const moreButton = document.createElement("button");
    moreButton.className = "project-more";
    moreButton.type = "button";
    moreButton.setAttribute("aria-expanded", String(state.showAllProjects));
    moreButton.setAttribute("aria-controls", "project-list");
    const moreCaret = document.createElement("span");
    moreCaret.className = "more-caret";
    moreCaret.setAttribute("aria-hidden", "true");
    const moreLabel = document.createElement("span");
    moreLabel.className = "more-label";
    moreLabel.textContent = state.showAllProjects
      ? t("showFewerProjects")
      : t("showMoreProjects");
    // 与来源树披露行同构：计数列收起态显示未展示数，展开后清空。
    const moreCount = document.createElement("strong");
    moreCount.className = "more-count";
    moreCount.textContent = state.showAllProjects
      ? ""
      : String(entries.length - PROJECT_PREVIEW_LIMIT);
    moreButton.append(moreCaret, moreLabel, moreCount);
    moreButton.addEventListener("click", () => {
      state.showAllProjects = !state.showAllProjects;
      renderProjectNav();
      elements.projectNav
        ?.querySelector(".project-more")
        ?.focus({ preventScroll: true });
    });
    elements.projectNav?.append(moreButton);
  }
}

export function updateFacetFilters() {
  if (!state.facets) {
    return;
  }

  fillSelect(
    elements.providerFilter,
    state.facets.providers,
    undefined,
    t("provider")
  );
  fillSelect(elements.dateFilter, state.facets.dates, undefined, t("date"));
  fillSelect(
    elements.workspaceTagFilter,
    state.facets.workspace_tags || [],
    undefined,
    t("workspaceTagFilter")
  );
  renderProjectNav();
}

export function syncSessionRoot() {
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
export function syncFilterControls() {
  if (elements.providerFilter)
    elements.providerFilter.value = state.filters.provider;
  if (elements.dateFilter) elements.dateFilter.value = state.filters.date;
  if (elements.workspaceTagFilter)
    elements.workspaceTagFilter.value = state.filters.tag;
  if (elements.searchInput) elements.searchInput.value = state.searchQuery;
  if (elements.searchRoleFilter)
    elements.searchRoleFilter.value = state.searchRole;
  if (elements.searchToolInput)
    elements.searchToolInput.value = state.searchTool;
  if (elements.searchRegexToggle)
    elements.searchRegexToggle.setAttribute(
      "aria-pressed",
      state.searchRegex ? "true" : "false"
    );
  if (elements.searchFromInput)
    elements.searchFromInput.value = state.searchFrom;
  if (elements.searchToInput) elements.searchToInput.value = state.searchTo;
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
    elements.favoriteOnlyToggle.setAttribute(
      "aria-pressed",
      state.favoriteOnly ? "true" : "false"
    );
  }
  renderProjectNav();
  renderWorkspaceStatus();
}
export function buildSessionQuery() {
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

// facets 只应用显示开关：项目计数与列表可见口径一致，导航维度不反向收窄。
export function buildFacetsQuery() {
  const params = new URLSearchParams();
  if (state.showArchived) params.set("show_archived", "true");
  if (state.showCodexArchived) params.set("show_codex_archived", "true");
  if (state.showHidden) params.set("show_hidden", "true");
  if (state.showRemoved) params.set("show_removed", "true");
  return params.toString();
}

export function buildSessionsUrl({ cursor } = {}) {
  const query = buildSessionQuery();
  const prefix = query ? `/api/sessions?${query}&` : "/api/sessions?";
  let url = `${prefix}limit=${PAGE_LIMIT}`;
  if (cursor) url += `&cursor=${cursor}`;
  return url;
}

export function buildSearchUrl({ cursor } = {}) {
  const params = new URLSearchParams(buildSessionQuery());
  params.set("q", state.searchQuery);
  params.set("sort", state.searchSort);
  if (state.searchRole) params.set("role", state.searchRole);
  if (state.searchTool) params.set("tool", state.searchTool);
  if (state.searchRegex) params.set("regex", "1");
  if (state.searchFrom) params.set("from", state.searchFrom);
  if (state.searchTo) params.set("to", state.searchTo);
  params.set("limit", String(PAGE_LIMIT));
  if (cursor) params.set("cursor", cursor);
  return `/api/search?${params.toString()}`;
}
export async function clearFilterChip(type) {
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

export function activeFilterEntries() {
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
      value: sourceKindLabel(state.filters.source_kind),
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

// 筛选 chip 的关闭图标：与删除对话框的 SVG X 同一几何，避免文本字符随字体漂移。
function createCloseIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "10");
  svg.setAttribute("fill", "none");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 6l12 12M18 6L6 18");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2.4");
  path.setAttribute("stroke-linecap", "round");
  svg.append(path);
  return svg;
}

export function renderActiveFilters() {
  if (!elements.activeFilterBar) return;
  renderWorkspaceStatus();

  const entries = activeFilterEntries().filter(
    (entry) =>
      entry.type !== "source_kind" &&
      (state.activeView !== "stats" || entry.type !== "search")
  );
  elements.resetFilters?.classList.toggle(
    "hidden",
    !activeFilterEntries().length
  );
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
    closeSpan.setAttribute("aria-hidden", "true");
    closeSpan.append(createCloseIcon());

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
export function resetFilterState() {
  state.filters = {
    provider: "",
    source_kind: "",
    date: "",
    cwd: "",
    tag: "",
  };
  state.searchQuery = "";
  state.searchRole = "";
  state.searchTool = "";
  state.searchRegex = false;
  state.searchFrom = "";
  state.searchTo = "";
  state.showArchived = false;
  state.showCodexArchived = false;
  state.showHidden = false;
  state.showRemoved = false;
  state.favoriteOnly = false;
}
