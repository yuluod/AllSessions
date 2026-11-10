// 删除与归档对话框:二次确认、永久删除(带备份)与恢复移除。
import { t } from "../i18n.js";
import { displaySessionTitle } from "../session-format.js";
import { showDialogFromPopover } from "../ui-components.js";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
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
  showDialogFromPopover(elements.archiveDialog);
  elements.archiveDialogConfirm?.focus();
}

// 归档与恢复共用一条通路：成功后给出「撤销」toast，让可逆操作真的可逆。
export async function setSessionArchived(
  sessionKey,
  archived,
  offerUndo = true
) {
  await updateSessionWorkspace(sessionKey, { archived });
  syncSessionArchiveButton();
  await Promise.all([loadSessions(), loadStats(), loadFacets()]);
  announce(
    t(archived ? "sessionArchived" : "sessionUnarchived"),
    offerUndo
      ? {
          actionLabel: t("toastUndo"),
          onAction: () => {
            void setSessionArchived(sessionKey, !archived, false).catch(
              (error) =>
                showError(`${t("workspaceSaveFailed")}: ${error.message}`)
            );
          },
        }
      : undefined
  );
}

export async function confirmSessionArchive() {
  if (!pendingArchive) return;
  const sessionKey = pendingArchive;
  elements.archiveDialogConfirm.disabled = true;
  elements.archiveDialogClose.disabled = true;
  elements.archiveDialogCancel.disabled = true;
  try {
    await setSessionArchived(sessionKey, true);
    pendingArchive = null;
    elements.archiveDialog.close();
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
  const sessionTitle =
    kind === "session"
      ? displaySessionTitle(state.currentDetail?.summary).trim()
      : "";
  const namedTitle =
    sessionTitle.length > 24 ? `${sessionTitle.slice(0, 24)}…` : sessionTitle;
  elements.deleteDialogTitle.textContent = t(
    removed
      ? "manageRemovedTitle"
      : kind === "session"
        ? sessionTitle
          ? "removeSessionTitleNamed"
          : "removeSessionTitle"
        : "removeMessageTitle",
    sessionTitle ? { title: namedTitle } : {}
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
  showDialogFromPopover(elements.deleteDialog);
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
  renderPropsPanel(state.currentDetail.summary);
}

function undoAction(redo) {
  return {
    actionLabel: t("toastUndo"),
    onAction: () => {
      void redo().catch((error) =>
        showError(`${t("workspaceSaveFailed")}: ${error.message}`)
      );
    },
  };
}

// 「从 AllSessions 移除」是可逆标记：成功后 toast 直接给撤销入口，
// 不必先学会「显示已移除内容」这条恢复路径。
export async function applySessionRemoval(
  sessionKey,
  removed,
  offerUndo = true
) {
  await updateSessionWorkspace(sessionKey, { removed });
  if (
    removed &&
    !state.showRemoved &&
    state.selectedSessionKey === sessionKey
  ) {
    state.selectedSessionKey = null;
    state.currentDetail = null;
    showSelectSessionPlaceholder();
    syncUrl();
  }
  await Promise.all([loadSessions(), loadStats(), loadFacets()]);
  refreshDeletionViews();
  announce(
    t(removed ? "contentRemoved" : "contentRestored"),
    offerUndo
      ? undoAction(() => applySessionRemoval(sessionKey, !removed, false))
      : undefined
  );
}

export async function applyMessageRemoval(
  sessionKey,
  messageKey,
  removed,
  offerUndo = true
) {
  await updateMessageWorkspace(sessionKey, messageKey, removed);
  refreshDeletionViews();
  announce(
    t(removed ? "contentRemoved" : "contentRestored"),
    offerUndo
      ? undoAction(() =>
          applyMessageRemoval(sessionKey, messageKey, !removed, false)
        )
      : undefined
  );
}

export async function restoreRemovedMessage(message) {
  const sessionKey = state.currentDetail?.summary?._key;
  if (!sessionKey || !message?._message_key) return;
  try {
    await applyMessageRemoval(sessionKey, message._message_key, false);
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
      await applySessionRemoval(sessionKey, !removed);
    } else if (messageKey) {
      await applyMessageRemoval(sessionKey, messageKey, !removed);
    }
    pendingDeletion = null;
    elements.deleteDialog.close();
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
    // 备份路径是错过即不可找回的信息：sticky toast 携带「显示」动作，
    // 不随定时器消失，供事后回查。
    announce(
      t(messageKey, { path: backupPath || "" }),
      backupPath
        ? {
            actionLabel: t("toastShowInFolder"),
            sticky: true,
            onAction: () => {
              void revealItemInDir(backupPath).catch((error) =>
                showError(`${t("revealFailed")}: ${error.message || error}`)
              );
            },
          }
        : undefined
    );
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
