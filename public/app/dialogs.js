// 删除与归档对话框:二次确认、永久删除(带备份)与恢复移除。
import { t } from "../i18n.js";
import {
  announce,
  elements,
  fetchJson,
  isMessageRemoved,
  sessionWorkspace,
  showError,
  state,
} from "./shared.js";
import { syncUrl } from "./filters.js";
import { renderSessionList } from "./session-list.js";
import { conversationView } from "./controllers.js";
import {
  renderDetailTags,
  renderPropsPanel,
  showSelectSessionPlaceholder,
  syncSessionArchiveButton,
  syncSessionDeleteButton,
} from "./detail-view.js";
import { updateMessageWorkspace, updateSessionWorkspace } from "./workspace.js";
import { loadFacets, loadSessions, loadStats } from "./data.js";

let pendingDeletion = null;
let pendingArchive = null;

export function closeArchiveConfirmDialog() {
  if (elements.archiveDialogConfirm?.disabled) return;
  elements.archiveDialog?.close();
  pendingArchive = null;
}

export function openArchiveConfirmDialog(sessionKey) {
  if (!sessionKey || !elements.archiveDialog) return;
  pendingArchive = sessionKey;
  elements.archiveDialogStatus.textContent = "";
  elements.archiveDialog.showModal();
  elements.archiveDialogConfirm?.focus();
}

export async function confirmSessionArchive() {
  if (!pendingArchive) return;
  const sessionKey = pendingArchive;
  elements.archiveDialogConfirm.disabled = true;
  elements.archiveDialogClose.disabled = true;
  elements.archiveDialogCancel.disabled = true;
  try {
    await updateSessionWorkspace(sessionKey, { archived: true });
    syncSessionArchiveButton();
    pendingArchive = null;
    elements.archiveDialog.close();
    await Promise.all([loadSessions(), loadStats(), loadFacets()]);
    announce(t("sessionArchived"));
  } catch (error) {
    elements.archiveDialogStatus.textContent = `${t("workspaceSaveFailed")}: ${error.message}`;
  } finally {
    elements.archiveDialogConfirm.disabled = false;
    elements.archiveDialogClose.disabled = false;
    elements.archiveDialogCancel.disabled = false;
  }
}

export function closeDeleteDialog() {
  if (elements.deleteConfirmBtn?.disabled) return;
  elements.deleteDialog?.close();
  pendingDeletion = null;
}

export function openDeleteDialog({ kind, message = null }) {
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
    state.currentDetail?.summary?.source_read_only === true ||
      (kind === "message" && state.currentDetail?.search_context === true)
  );
  elements.deleteSoftBtn.classList.remove("hidden");
  elements.deleteSoftBtn.textContent = t(
    removed ? "restore" : "removeFromAllSessions"
  );
  elements.deleteDialog.showModal();
  elements.deleteSoftBtn.focus();
}

export function refreshDeletionViews() {
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

export async function restoreRemovedMessage(message) {
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

export async function applySoftDeletion() {
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

export function showPermanentDeleteConfirmation() {
  if (!pendingDeletion) return;
  elements.deleteDialogWarning.classList.remove("hidden");
  elements.deleteSoftBtn.classList.add("hidden");
  elements.deletePermanentBtn.classList.add("hidden");
  elements.deleteConfirmBtn.classList.remove("hidden");
  elements.deleteConfirmBtn.focus();
}

export async function confirmPermanentDeletion() {
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

export function clearPendingDeletion() {
  pendingDeletion = null;
}

export function clearPendingArchive() {
  pendingArchive = null;
}
