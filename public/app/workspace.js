// 个人工作台数据:旧版 localStorage 迁移、工作区 API、常用筛选与批量导出。
import { t } from "../i18n.js";
import { mapWithConcurrency } from "../async-coordinator.js";
import { exportSessionCollection } from "../session-export.js";
import {
  announce,
  elements,
  fetchJson,
  showError,
  state,
  ARCHIVE_KEY,
  BULK_EXPORT_CONCURRENCY,
  MAX_BULK_EXPORT_SESSIONS,
  REMOVED_MESSAGES_KEY,
  REMOVED_SESSIONS_KEY,
} from "./shared.js";
import {
  applyFilterValue,
  currentFilterValue,
  syncFilterControls,
  syncUrl,
} from "./filters.js";
import { updateBulkToolbar } from "./session-list.js";
import { loadSessions, loadStats } from "./data.js";

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
export async function updateSessionWorkspace(sessionKey, patch) {
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
export async function updateMessageWorkspace(sessionKey, messageKey, removed) {
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

export async function loadWorkspaceState() {
  await migrateLegacyWorkspace();
  state.workspace = await fetchJson("/api/workspace");
  renderSavedFilters();
  updateBulkToolbar();
}
export function renderSavedFilters() {
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
        state.workspace.saved_filters = (
          state.workspace.saved_filters || []
        ).filter((filter) => filter.id !== saved.id);
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

export async function saveCurrentFilter() {
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
export async function exportSelectedSessions() {
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
