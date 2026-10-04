// 应用入口:装配各模块、绑定全局事件并执行初始化与首屏加载。
import { t, getLang, updateStaticI18n } from "./i18n.js";
import { initTheme, toggleScheme } from "./theme-manager.js";
import { initPaneLayout } from "./pane-layout.js";
import { resolveGlobalShortcut, resolveTabIndex } from "./keyboard-nav.js";
import { exportSessionMarkdown, exportSessionJson } from "./session-export.js";
import { bindTauriSessionEvents } from "./session-events.js";
import { DESKTOP_RUNTIME_REQUIRED } from "./api-client.js";
import { renderStats } from "./stats-view.js";
import {
  INSPECTOR_DRAWER_QUERY,
  MOBILE_LAYOUT_QUERY,
  announce,
  detailRequestGate,
  elements,
  scrollToWorkspaceSection,
  sessionRequestGate,
  sessionWorkspace,
  showError,
  state,
  visibleSessions,
} from "./app/shared.js";
import {
  resetFilterState,
  restoreFromUrl,
  setSourceKindFilter,
  syncFilterControls,
  syncSessionRoot,
  syncUrl,
  updateFacetFilters,
} from "./app/filters.js";
import {
  renderSessionList,
  setSessionSelected,
  updateBulkToolbar,
} from "./app/session-list.js";
import {
  parseWorkspaceTags,
  renderDetailTags,
  renderPropsPanel,
  renderRawEvents,
  resumeCurrentSession,
  revealCurrentPath,
  setDetailPlaceholder,
  setInspectorOpen,
  setPropsPlaceholder,
  syncInspectorLayout,
  syncSessionArchiveButton,
  syncSessionDeleteButton,
  syncRoleFilterButtons,
  syncSessionWorkspaceControls,
  updateTabs,
} from "./app/detail-view.js";
import {
  applySoftDeletion,
  clearPendingArchive,
  clearPendingDeletion,
  closeArchiveConfirmDialog,
  closeDeleteDialog,
  confirmPermanentDeletion,
  confirmSessionArchive,
  openArchiveConfirmDialog,
  openDeleteDialog,
  showPermanentDeleteConfirmation,
} from "./app/dialogs.js";
import {
  exportSelectedSessions,
  loadWorkspaceState,
  renderSavedFilters,
  saveCurrentFilter,
  updateSessionWorkspace,
} from "./app/workspace.js";
import {
  indexProgressPoller,
  loadCapabilities,
  loadFacets,
  loadSessionDetail,
  loadSessions,
  loadStats,
  loadWorkspaceDiagnostics,
} from "./app/data.js";
import {
  defaultSourceRailCollapsed,
  setSourceRailCollapsed,
  syncSchemeToggle,
  syncShortcutHints,
  syncSourceRailToggle,
  renderWorkspaceStatus,
} from "./app/status.js";
import {
  activateWorkspaceView,
  closeTopDialogFromKeyboard,
  isEditableShortcutTarget,
  moveSessionSelection,
  openFocusedSession,
  refreshSessions,
  returnHome,
} from "./app/navigation.js";
import {
  bindTauriSettingsEvent,
  conversationView,
  maintenanceController,
  settingsController,
  updateController,
} from "./app/controllers.js";

initTheme();
initPaneLayout();

export function rerenderLocalizedContent() {
  syncSchemeToggle();
  syncSourceRailToggle();
  syncSessionRoot();
  updateFacetFilters();
  syncFilterControls();
  if (state.workspaceLoadError) {
    renderWorkspaceLoadFailure(state.workspaceLoadError);
  } else {
    renderSessionList();
  }
  if (state.currentDetail) {
    const fullCwd = state.currentDetail.summary.cwd || t("noWorkDir");
    elements.detailTitle.textContent =
      state.currentDetail.summary.title ||
      fullCwd.split(/[\\/]/).pop() ||
      fullCwd;
    elements.detailTitle.title = fullCwd;
    renderDetailTags(state.currentDetail.summary);
    syncSessionWorkspaceControls(state.currentDetail.summary);
    syncSessionArchiveButton();
    syncSessionDeleteButton();
    renderPropsPanel(
      state.currentDetail.summary,
      state.currentDetail.conversation_messages
    );
    conversationView.renderConversation(
      state.currentDetail.conversation_messages
    );
    renderRawEvents(state.currentDetail.raw_events);
    updateTabs();
  } else {
    setDetailPlaceholder(t("selectSession"), t("selectSessionDesc"));
    setPropsPlaceholder(t("selectSession"));
  }
  renderSavedFilters();
  updateBulkToolbar();
  if (state.stats) {
    renderStats(state.stats, elements);
  }
  renderWorkspaceStatus();
  syncShortcutHints();
  maintenanceController.renderLocalized();
  updateController.renderLocalized();
}
function isDesktopRuntimeUnavailable(error) {
  return error instanceof Error && error.code === DESKTOP_RUNTIME_REQUIRED;
}
function renderWorkspaceLoadFailure(error) {
  state.workspaceLoadError = error;
  const message =
    error instanceof Error && error.message ? error.message : t("errorUnknown");
  const stateCard = document.createElement("section");
  stateCard.className = "workspace-load-state";
  stateCard.setAttribute("role", "alert");

  const heading = document.createElement("h2");
  heading.textContent = t("workspaceUnavailable");

  const copy = document.createElement("p");
  copy.textContent = isDesktopRuntimeUnavailable(error)
    ? t("desktopAppRequired")
    : t("workspaceLoadHelp");

  const retryButton = document.createElement("button");
  retryButton.className = "ghost-button";
  retryButton.type = "button";
  retryButton.textContent = t("retry");
  retryButton.addEventListener("click", async () => {
    retryButton.disabled = true;
    retryButton.textContent = t("retrying");
    await loadInitialWorkspace();
  });

  const actions = document.createElement("div");
  actions.className = "workspace-load-actions";
  actions.append(retryButton);
  if (!isDesktopRuntimeUnavailable(error)) {
    const settingsButton = document.createElement("button");
    settingsButton.className = "ghost-button";
    settingsButton.type = "button";
    settingsButton.textContent = t("openSettingsForRecovery");
    settingsButton.addEventListener("click", () => {
      void settingsController.open("sources");
    });
    actions.append(settingsButton);
  }

  stateCard.append(heading, copy);
  if (!isDesktopRuntimeUnavailable(error)) {
    const detail = document.createElement("p");
    detail.className = "workspace-load-detail";
    detail.textContent = message;
    stateCard.append(detail);
  }
  stateCard.append(actions);
  elements.sessionList.replaceChildren(stateCard);
  elements.activeFilterBar?.replaceChildren();
  elements.sessionCount.textContent = "-";
  elements.sessionRoot.textContent = t("workspaceUnavailable");
  elements.sessionRoot.removeAttribute("title");
  renderWorkspaceStatus();
}

function openRecoverySettingsOnce() {
  if (
    state.capabilities?.recovery_required !== true ||
    state.recoverySettingsOpened
  ) {
    return;
  }
  state.recoverySettingsOpened = true;
  void settingsController.open("sources");
}

async function bindTauriSessionEventsOnce() {
  if (state.tauriEventsBound) return;
  try {
    await bindTauriSessionEvents({
      refresh: async () => {
        void indexProgressPoller.refresh();
        await Promise.all([loadFacets(), loadWorkspaceDiagnostics()]);
        await Promise.all([loadSessions({ background: true }), loadStats()]);
      },
      onSessionAdded: (summary) => {
        const ariaLive = document.querySelector("#aria-live");
        if (!ariaLive) return;
        ariaLive.textContent = `${t("newSessionAdded")}: ${summary.cwd || summary.id}`;
        setTimeout(() => {
          ariaLive.textContent = "";
        }, 3000);
      },
      onMalformed: (error) =>
        console.warn("Invalid session event payload", error),
      onError: (error) => {
        console.error(error);
        showError(`${t("refreshFailed")}: ${error.message}`);
      },
    });
    state.tauriEventsBound = true;
  } catch (error) {
    console.warn("Tauri session event binding is unavailable", error);
  }
}

async function loadInitialWorkspace() {
  if (!state._initialized) {
    state.scanning = true;
    renderSessionList();
  }
  try {
    // 后端首次扫描在后台进行，先订阅事件再拉取，避免漏掉扫描完成通知。
    await bindTauriSessionEventsOnce();
    await loadWorkspaceState();
    await Promise.all([
      loadFacets(),
      loadCapabilities(),
      loadWorkspaceDiagnostics(),
    ]);
    const sessionsLoaded = await loadSessions({ reportError: false });
    if (!sessionsLoaded) {
      throw state.lastSessionError || new Error(t("loadListFailed"));
    }
    state._initialized = true;
    void indexProgressPoller.refresh();
    state.workspaceLoadError = null;
    void loadStats();
    openRecoverySettingsOnce();
    return true;
  } catch (error) {
    console.error(error);
    state._initialized = false;
    renderWorkspaceLoadFailure(error);
    openRecoverySettingsOnce();
    return false;
  }
}

async function initialize() {
  restoreFromUrl();
  maintenanceController.bind();
  setSourceRailCollapsed(defaultSourceRailCollapsed());
  syncInspectorLayout();
  syncSchemeToggle();
  elements.schemeToggle?.addEventListener("click", toggleScheme);
  document.addEventListener("allsessions:themechange", syncSchemeToggle);
  elements.railToggle?.addEventListener("click", () => {
    const collapsed = !elements.appLayout?.classList.contains("rail-collapsed");
    setSourceRailCollapsed(collapsed, { persist: true });
  });
  window.matchMedia(MOBILE_LAYOUT_QUERY).addEventListener("change", () => {
    setSourceRailCollapsed(defaultSourceRailCollapsed());
  });
  window
    .matchMedia(INSPECTOR_DRAWER_QUERY)
    .addEventListener("change", syncInspectorLayout);

  elements.homeLink?.addEventListener("click", (event) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    returnHome().catch((error) => {
      console.error(error);
      showError(`${t("loadListFailed")}: ${error.message}`);
    });
  });

  elements.sourceRailItems.forEach((button) => {
    button.addEventListener("click", () => {
      setSourceKindFilter(button.dataset.sourceKind || "").catch((error) => {
        console.error(error);
        showError(`${t("loadListFailed")}: ${error.message}`);
      });
    });
  });
  elements.statusHealthButton?.addEventListener("click", () => {
    void settingsController.open("sources");
  });

  elements.providerFilter?.addEventListener("change", async (event) => {
    state.filters.provider = event.target.value;
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  elements.dateFilter?.addEventListener("change", async (event) => {
    state.filters.date = event.target.value;
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  elements.workspaceTagFilter?.addEventListener("change", async (event) => {
    state.filters.tag = event.target.value;
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  elements.resetFilters?.addEventListener("click", async () => {
    resetFilterState();
    syncFilterControls();
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  elements.refreshBtn?.addEventListener("click", () => {
    void refreshSessions();
  });

  if (elements.showArchivedToggle) {
    elements.showArchivedToggle.addEventListener("change", async () => {
      state.showArchived = elements.showArchivedToggle.checked;
      syncUrl();
      await Promise.all([loadSessions(), loadStats()]);
    });
  }

  if (elements.showCodexArchivedToggle) {
    elements.showCodexArchivedToggle.addEventListener("change", async () => {
      state.showCodexArchived = elements.showCodexArchivedToggle.checked;
      syncUrl();
      await Promise.all([loadSessions(), loadStats()]);
    });
  }

  if (elements.showHiddenToggle) {
    elements.showHiddenToggle.addEventListener("change", async () => {
      state.showHidden = elements.showHiddenToggle.checked;
      syncUrl();
      await Promise.all([loadSessions(), loadStats()]);
    });
  }

  if (elements.showRemovedToggle) {
    elements.showRemovedToggle.addEventListener("change", async () => {
      state.showRemoved = elements.showRemovedToggle.checked;
      syncUrl();
      await Promise.all([loadSessions(), loadStats()]);
    });
  }

  elements.favoriteOnlyToggle?.addEventListener("click", async () => {
    state.favoriteOnly = !state.favoriteOnly;
    syncFilterControls();
    syncUrl();
    await Promise.all([loadSessions(), loadStats()]);
  });

  elements.saveFilterBtn?.addEventListener("click", saveCurrentFilter);
  elements.savedFilterName?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveCurrentFilter();
    }
  });

  elements.selectVisibleBtn?.addEventListener("click", () => {
    const visible = visibleSessions();
    const allSelected =
      visible.length > 0 &&
      visible.every((session) => state.selectedSessionKeys.has(session._key));
    visible.forEach((session) =>
      setSessionSelected(session._key, !allSelected)
    );
  });
  elements.clearSelectionBtn?.addEventListener("click", () => {
    state.selectedSessionKeys.clear();
    renderSessionList();
  });
  elements.bulkExportBtn?.addEventListener("click", exportSelectedSessions);

  elements.openCodexArchiveBtn?.addEventListener("click", async () => {
    state.showCodexArchived = true;
    state.filters.source_kind = "codex_archived";
    if (elements.showCodexArchivedToggle)
      elements.showCodexArchivedToggle.checked = true;
    if (elements.sidebarFilters) elements.sidebarFilters.open = true;
    syncFilterControls();
    syncUrl();
    await activateWorkspaceView("list");
    await Promise.all([loadSessions(), loadStats()]);
    elements.sidebarLeft?.scrollIntoView({ block: "start" });
  });

  elements.mobileBackBtn?.addEventListener("click", () =>
    scrollToWorkspaceSection(elements.sidebarLeft)
  );

  elements.sessionDeleteBtn?.addEventListener("click", () =>
    openDeleteDialog({ kind: "session" })
  );
  elements.sessionArchiveBtn?.addEventListener("click", async () => {
    const key = state.currentDetail?.summary?._key;
    if (!key) return;
    if (sessionWorkspace(key).archived !== true) {
      openArchiveConfirmDialog(key);
      return;
    }
    elements.sessionArchiveBtn.disabled = true;
    try {
      await updateSessionWorkspace(key, { archived: false });
      syncSessionArchiveButton();
      await Promise.all([loadSessions(), loadStats(), loadFacets()]);
      announce(t("sessionUnarchived"));
    } catch (error) {
      showError(`${t("workspaceSaveFailed")}: ${error.message}`);
    } finally {
      elements.sessionArchiveBtn.disabled = false;
    }
  });
  elements.archiveDialogClose?.addEventListener(
    "click",
    closeArchiveConfirmDialog
  );
  elements.archiveDialogCancel?.addEventListener(
    "click",
    closeArchiveConfirmDialog
  );
  elements.archiveDialogConfirm?.addEventListener(
    "click",
    confirmSessionArchive
  );
  elements.archiveDialog?.addEventListener("click", (event) => {
    if (event.target === elements.archiveDialog) closeArchiveConfirmDialog();
  });
  elements.archiveDialog?.addEventListener("cancel", (event) => {
    if (elements.archiveDialogConfirm?.disabled) event.preventDefault();
    else clearPendingArchive();
  });
  elements.deleteDialogClose?.addEventListener("click", closeDeleteDialog);
  elements.deleteSoftBtn?.addEventListener("click", applySoftDeletion);
  elements.deletePermanentBtn?.addEventListener(
    "click",
    showPermanentDeleteConfirmation
  );
  elements.deleteConfirmBtn?.addEventListener(
    "click",
    confirmPermanentDeletion
  );
  elements.deleteDialog?.addEventListener("click", (event) => {
    if (event.target === elements.deleteDialog) closeDeleteDialog();
  });
  elements.deleteDialog?.addEventListener("cancel", (event) => {
    if (elements.deleteConfirmBtn?.disabled) event.preventDefault();
    else clearPendingDeletion();
  });

  elements.sessionInspectorToggle?.addEventListener("click", () => {
    const panel = elements.propsContent?.closest(".props-panel");
    setInspectorOpen(!panel?.classList.contains("is-open"));
  });
  elements.propsCloseBtn?.addEventListener("click", () => {
    setInspectorOpen(false);
    elements.sessionInspectorToggle?.focus();
  });

  if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches && elements.projectNav) {
    elements.projectNav.open = false;
  }

  const workspaceTabs = Array.from(document.querySelectorAll(".sidebar-tab"));
  workspaceTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      activateWorkspaceView(tab.dataset.sidebarTab).catch((error) => {
        console.error(error);
        showError(error.message);
      });
    });
    tab.addEventListener("keydown", (event) => {
      const nextIndex = resolveTabIndex(
        event.key,
        workspaceTabs.indexOf(tab),
        workspaceTabs.length
      );
      if (nextIndex === null) return;
      event.preventDefault();
      workspaceTabs[nextIndex].focus();
      workspaceTabs[nextIndex].click();
    });
  });

  if (elements.exportMdBtn) {
    elements.exportMdBtn.addEventListener("click", () => {
      if (state.currentDetail) {
        exportSessionMarkdown(state.currentDetail, {
          redact: elements.exportRedactToggle?.checked === true,
        });
      }
    });
  }

  if (elements.exportJsonBtn) {
    elements.exportJsonBtn.addEventListener("click", () => {
      if (state.currentDetail) {
        exportSessionJson(state.currentDetail, {
          redact: elements.exportRedactToggle?.checked === true,
        });
      }
    });
  }

  elements.sessionFavoriteBtn?.addEventListener("click", async () => {
    const key = state.currentDetail?.summary?._key;
    if (!key) return;
    elements.sessionFavoriteBtn.disabled = true;
    try {
      const favorite = sessionWorkspace(key).favorite !== true;
      await updateSessionWorkspace(key, { favorite });
      syncSessionWorkspaceControls(state.currentDetail.summary);
      renderDetailTags(state.currentDetail.summary);
      await Promise.all([loadSessions(), loadStats(), loadFacets()]);
      announce(t(favorite ? "sessionFavorited" : "sessionUnfavorited"));
    } catch (error) {
      showError(`${t("workspaceSaveFailed")}: ${error.message}`);
    } finally {
      elements.sessionFavoriteBtn.disabled = false;
    }
  });

  elements.saveSessionWorkspaceBtn?.addEventListener("click", async () => {
    const key = state.currentDetail?.summary?._key;
    if (!key) return;
    elements.saveSessionWorkspaceBtn.disabled = true;
    try {
      await updateSessionWorkspace(key, {
        tags: parseWorkspaceTags(elements.sessionTagsInput?.value || ""),
        note: elements.sessionNoteInput?.value || "",
      });
      syncSessionWorkspaceControls(state.currentDetail.summary);
      renderDetailTags(state.currentDetail.summary);
      renderSessionList();
      await loadFacets();
      announce(t("workspaceSaved"));
      if (elements.sessionOrganizeMenu)
        elements.sessionOrganizeMenu.open = false;
    } catch (error) {
      showError(`${t("workspaceSaveFailed")}: ${error.message}`);
    } finally {
      elements.saveSessionWorkspaceBtn.disabled = false;
    }
  });
  elements.revealSourceBtn?.addEventListener("click", () => {
    void revealCurrentPath("source");
  });
  elements.revealProjectBtn?.addEventListener("click", () => {
    void revealCurrentPath("project");
  });
  elements.resumeSessionBtn?.addEventListener("click", () => {
    void resumeCurrentSession();
  });

  let searchDebounce = null;
  document
    .querySelector("#search-sort")
    ?.addEventListener("change", (event) => {
      state.searchSort = event.target.value;
      void loadSessions();
    });
  document
    .querySelector("#search-full-session")
    ?.addEventListener("click", () => {
      state.selectedSearchHit = null;
      void loadSessionDetail(state.selectedSessionKey);
    });
  elements.searchInput?.addEventListener("input", (event) => {
    const query = event.target.value.trim();
    clearTimeout(searchDebounce);
    sessionRequestGate.cancel();
    detailRequestGate.cancel();
    state.selectedSearchHit = null;
    searchDebounce = setTimeout(async () => {
      const switchedView = state.activeView !== "list";
      if (switchedView) {
        await activateWorkspaceView("list");
      }
      state.searchQuery = query;
      syncUrl();
      await loadSessions();
      if (switchedView && window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
        scrollToWorkspaceSection(elements.sidebarLeft);
      }
    }, 300);
  });

  document.addEventListener("keydown", (event) => {
    const activeElement = document.activeElement;
    const action = resolveGlobalShortcut(event, {
      editableTarget: isEditableShortcutTarget(event.target),
      dialogOpen: Boolean(document.querySelector("dialog[open]")),
      inspectorOpen: Boolean(
        elements.propsContent
          ?.closest(".props-panel")
          ?.classList.contains("is-open")
      ),
      arrowFromList:
        elements.sessionList.contains(activeElement) ||
        activeElement === document.body,
    });
    if (!action) return;
    switch (action.type) {
      case "close-dialog":
        if (closeTopDialogFromKeyboard()) event.preventDefault();
        break;
      case "close-inspector":
        event.preventDefault();
        setInspectorOpen(false);
        elements.sessionInspectorToggle?.focus();
        break;
      case "focus-search":
        event.preventDefault();
        elements.searchInput?.focus();
        elements.searchInput?.select();
        break;
      case "toggle-settings":
        event.preventDefault();
        if (elements.settingsDialog?.open) {
          elements.settingsDialog.close();
        } else if (!document.querySelector("dialog[open]")) {
          void settingsController.open();
        }
        break;
      case "refresh":
        event.preventDefault();
        void refreshSessions();
        break;
      case "toggle-inspector":
        event.preventDefault();
        setInspectorOpen(
          !elements.propsContent
            ?.closest(".props-panel")
            ?.classList.contains("is-open")
        );
        break;
      case "switch-view":
        event.preventDefault();
        activateWorkspaceView(action.view).catch((error) => {
          console.error(error);
          showError(error.message);
        });
        break;
      case "move-selection":
        event.preventDefault();
        if (state.activeView !== "list") void activateWorkspaceView("list");
        moveSessionSelection(action.direction);
        break;
      case "open-focused":
        if (openFocusedSession()) event.preventDefault();
        break;
    }
  });

  elements.tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.tab;
      updateTabs();
    });
    button.addEventListener("keydown", (e) => {
      const tabs = elements.tabButtons;
      const idx = tabs.indexOf(button);
      let next = null;
      if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
      if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
      if (e.key === "Home") next = 0;
      if (e.key === "End") next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      tabs[next].focus();
      tabs[next].click();
    });
  });

  updateStaticI18n();
  document.documentElement.lang = getLang() === "zh" ? "zh-CN" : "en";
  syncShortcutHints();
  maintenanceController.renderLocalized();

  settingsController.bind();
  await updateController.bind();
  await bindTauriSettingsEvent();

  elements.detailSearchInput?.addEventListener("input", (event) => {
    state.detailQuery = event.target.value.trim();
    if (state.currentDetail) {
      conversationView.renderConversation(
        state.currentDetail.conversation_messages || []
      );
    }
  });

  elements.showToolsToggle?.addEventListener("change", () => {
    state.showTools = elements.showToolsToggle.checked;
    if (state.currentDetail) {
      conversationView.renderConversation(
        state.currentDetail.conversation_messages || []
      );
    }
  });

  elements.showContextToggle?.addEventListener("change", () => {
    state.showContext = elements.showContextToggle.checked;
    if (state.currentDetail) {
      conversationView.renderConversation(
        state.currentDetail.conversation_messages || []
      );
    }
  });

  elements.conversationDescToggle?.addEventListener("change", () => {
    state.conversationDesc = elements.conversationDescToggle.checked;
    if (state.currentDetail) {
      conversationView.renderConversation(
        state.currentDetail.conversation_messages || []
      );
    }
  });

  document.querySelectorAll("#role-filter .role-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.roleFilter = btn.dataset.role;
      syncRoleFilterButtons();
      if (state.currentDetail) {
        conversationView.renderConversation(
          state.currentDetail.conversation_messages || []
        );
      }
    });
  });

  await loadInitialWorkspace();
}

initialize().catch((error) => {
  console.error(error);
  renderWorkspaceLoadFailure(error);
});
