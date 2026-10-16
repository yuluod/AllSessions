// 个人工作台数据:旧版 localStorage 迁移、工作区 API 与批量导出。
import { t } from "../i18n.js";
import { mapWithConcurrency } from "../async-coordinator.js";
import { exportSessionCollection } from "../session-export.js";
import {
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
import { updateBulkToolbar } from "./session-list.js";

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
  updateBulkToolbar();
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
