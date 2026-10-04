// 筛选与查询:筛选状态、URL 同步、查询串构造、活动筛选 chips 与项目导航。
import { t } from "../i18n.js";
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
export function renderProjectNav() {
  if (!elements.projectList) return;

  const projects = state.facets?.projects || [];
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
    button.setAttribute(
      "aria-label",
      `${project.name || project.path} · ${t("projectSessionCount", { n: project.count })} · ${project.path}`
    );

    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = project.name || project.path;

    const meta = document.createElement("span");
    meta.className = "project-meta";
    meta.textContent = String(project.count);
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

  if (projects.length > PROJECT_PREVIEW_LIMIT) {
    const moreButton = document.createElement("button");
    moreButton.className = "project-item project-more";
    moreButton.type = "button";
    moreButton.setAttribute("aria-expanded", String(state.showAllProjects));
    moreButton.setAttribute("aria-controls", "project-list");
    moreButton.textContent = state.showAllProjects
      ? t("showFewerProjects")
      : t("showMoreProjects", { n: projects.length - PROJECT_PREVIEW_LIMIT });
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

  fillSelect(elements.providerFilter, state.facets.providers);
  fillSelect(elements.dateFilter, state.facets.dates);
  fillSelect(elements.workspaceTagFilter, state.facets.workspace_tags || []);
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

export function renderActiveFilters() {
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
export function resetFilterState() {
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
}
