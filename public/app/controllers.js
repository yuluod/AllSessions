// 子视图控制器装配:对话视图、设置、更新、交接与维护工具。
import { createConversationView } from "../conversation-view.js";
import { createMaintenanceController } from "../maintenance-view.js";
import { createSettingsController } from "../settings-view.js";
import { createUpdateController } from "../update-view.js";
import { createHandoffController } from "./handoff.js";
import { handoffSelectable } from "../handoff.js";
import {
  announce,
  displaySourceLabel,
  elements,
  fetchJson,
  isMessageRemoved,
  sessionWorkspace,
  showError,
  state,
} from "./shared.js";
export let conversationView;
export let settingsController;
export let updateController;
export let maintenanceController;
export let handoffController;

// 入口注入跨视图行为，控制器不再反向导入装配、数据或导航模块。
export function initializeControllers({
  onSelectSession,
  onRequestDelete,
  onRestoreMessage,
  onLanguageChanged,
  refreshData,
}) {
  conversationView = createConversationView({
    state,
    elements,
    isMessageRemoved,
    onSelectSession,
    onRequestDelete,
    onRestoreMessage,
    onHighlightError: showError,
    onOpenLink: (url) =>
      fetchJson("/api/links/open", { method: "POST", body: { url } }),
    onLinkError: showError,
    onLoadAttachment: (sessionKey, locator) =>
      fetchJson("/api/sessions/attachment", {
        method: "POST",
        body: { sessionKey, locator },
      }),
    // 交接控制器在对话视图之后创建，回调经延迟委托转发。
    handoff: {
      isActive: () => handoffController?.isActive() === true,
      isSelectable: handoffSelectable,
      isSelected: (key) => handoffController?.isSelected(key) === true,
      onToggle: (message) => handoffController?.toggle(message),
    },
  });
  handoffController = createHandoffController({
    state,
    elements,
    sessionWorkspace,
    displaySourceLabel,
    announce,
    showError,
    getConversationView: () => conversationView,
  });
  handoffController.bind();
  settingsController = createSettingsController({
    elements,
    onLanguageChanged,
    onSaved: () => {
      refreshData().catch((error) => showError(error.message));
    },
  });
  updateController = createUpdateController({
    requestJson: fetchJson,
  });
  maintenanceController = createMaintenanceController({
    requestJson: fetchJson,
    refreshData,
  });
}

export async function bindTauriSettingsEvent() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  await listen("open-settings", () => {
    settingsController.open();
  });
}
