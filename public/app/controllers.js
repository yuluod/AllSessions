// 子视图控制器装配:对话视图、设置、更新与维护工具。
import { createConversationView } from "../conversation-view.js";
import { createMaintenanceController } from "../maintenance-view.js";
import { createSettingsController } from "../settings-view.js";
import { createUpdateController } from "../update-view.js";
import {
  elements,
  fetchJson,
  isMessageRemoved,
  showError,
  state,
} from "./shared.js";
import { openDeleteDialog, restoreRemovedMessage } from "./dialogs.js";
import {
  loadFacets,
  loadSessions,
  loadStats,
  loadWorkspaceDiagnostics,
} from "./data.js";
import { rerenderLocalizedContent } from "../app.js";

export const conversationView = createConversationView({
  state,
  elements,
  isMessageRemoved,
  onRequestDelete: (message) => openDeleteDialog({ kind: "message", message }),
  onRestoreMessage: (message) => restoreRemovedMessage(message),
});
export const settingsController = createSettingsController({
  elements,
  onLanguageChanged: () => {
    rerenderLocalizedContent();
  },
  onSaved: () => {
    Promise.all([loadFacets(), loadWorkspaceDiagnostics()])
      .then(() => Promise.all([loadSessions(), loadStats()]))
      .catch((error) => showError(error.message));
  },
});
export const updateController = createUpdateController({
  requestJson: fetchJson,
});
export const maintenanceController = createMaintenanceController({
  requestJson: fetchJson,
  refreshData: async () => {
    await Promise.all([loadFacets(), loadWorkspaceDiagnostics()]);
    await Promise.all([loadSessions(), loadStats()]);
  },
});

export async function bindTauriSettingsEvent() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  await listen("open-settings", () => {
    settingsController.open();
  });
}
