import { t, getLang, setLang } from "./i18n.js";
import { DESKTOP_RUNTIME_REQUIRED, fetchJson } from "./api-client.js";
import { openUrl } from "@tauri-apps/plugin-opener";

const SOURCE_KINDS = [
  { key: "codex", label: "Codex" },
  { key: "codex_archived", label: "Codex Archived" },
  { key: "claude", label: "Claude Code" },
  { key: "gemini", label: "Gemini CLI" },
];

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export function createSettingsController({
  elements,
  onLanguageChanged,
  onSaved,
}) {
  let draft = null;
  let activeTab = "general";
  let savedPreferences = null;
  let latestPayload = null;

  function dialog() {
    return elements.settingsDialog;
  }

  function lockPageScroll() {
    document.documentElement.classList.add("settings-modal-open");
  }

  function unlockPageScroll() {
    document.documentElement.classList.remove("settings-modal-open");
  }

  function setStatus(message, isError = false) {
    if (!elements.settingsStatus) return;
    elements.settingsStatus.textContent = message;
    elements.settingsStatus.dataset.state = isError ? "error" : "info";
  }

  function activateTab(name, focus = false) {
    activeTab = name;
    elements.settingsTabs?.forEach((tab) => {
      const selected = tab.dataset.settingsTab === name;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    elements.settingsPanels?.forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== name;
    });
    dialog()?.setAttribute("data-active-tab", name);
  }

  function focusLastRootInput(container, key) {
    const inputs = container.querySelectorAll(
      `.settings-source[data-kind="${key}"] input`
    );
    inputs[inputs.length - 1]?.focus();
  }

  function sourceHealthState(diagnostic) {
    if (!diagnostic?.enabled) return "disabled";
    if ((diagnostic.error_count || 0) > 0) return "warning";
    if ((diagnostic.available_roots || 0) === 0) return "missing";
    return "ready";
  }

  function appendSourceHealth(block, diagnostic) {
    const state = sourceHealthState(diagnostic);
    const health = document.createElement("div");
    health.className = "settings-source-health";
    health.dataset.state = state;
    const badge = document.createElement("span");
    badge.className = "settings-health-badge";
    badge.textContent = t(`settingsSourceHealth_${state}`);
    const summary = document.createElement("span");
    summary.textContent = t("settingsSourceHealthSummary", {
      sessions: diagnostic?.indexed_sessions || 0,
      files: diagnostic?.discovered_files || 0,
    });
    health.append(badge, summary);
    if (diagnostic?.last_error) {
      const error = document.createElement("span");
      error.className = "settings-source-error";
      error.textContent = diagnostic.last_error;
      error.title = diagnostic.last_error;
      health.append(error);
    }
    block.append(health);
  }

  function renderSources(payload) {
    const container = elements.settingsSources;
    if (!container) return;
    container.replaceChildren();
    SOURCE_KINDS.forEach(({ key, label }) => {
      const resolved = payload?.resolved?.[key] || {
        roots: [],
        origin: "default",
      };
      const custom = draft?.[key] ?? null;
      const inheritedRoots = payload?.inherited?.[key]?.roots || [];
      const inheritedRootSet = new Set([
        ...inheritedRoots,
        ...(payload?.protected?.[key] || []),
      ]);
      const protectedRoots = new Set(
        custom?.filter((root) => inheritedRootSet.has(root)) || []
      );
      const customRoots =
        custom?.filter((root) => !protectedRoots.has(root)) || [];
      const sourceState =
        custom === null ? "inherited" : custom.length ? "custom" : "disabled";
      const originKey =
        sourceState === "inherited"
          ? resolved.origin
          : sourceState === "custom"
            ? "config"
            : "disabled";
      const block = document.createElement("div");
      block.className = "settings-source";
      block.dataset.state = sourceState;

      const header = document.createElement("div");
      header.className = "settings-source-header";
      const name = document.createElement("strong");
      name.textContent = label;
      const origin = document.createElement("span");
      origin.className = "settings-origin";
      origin.dataset.origin = originKey;
      origin.textContent = t(`settingsOrigin_${originKey}`);
      header.append(name, origin);
      block.append(header);

      if (custom === null) {
        const list = document.createElement("ul");
        list.className = "settings-root-list readonly";
        resolved.roots.forEach((root) => {
          const item = document.createElement("li");
          item.textContent = root;
          list.append(item);
        });
        if (!resolved.roots.length) {
          const item = document.createElement("li");
          item.textContent = t("settingsNoRoots");
          list.append(item);
        }
        const protection = document.createElement("p");
        protection.className = "settings-source-note";
        protection.textContent = t("settingsDefaultRootsProtected");
        const actions = document.createElement("div");
        actions.className = "settings-source-actions";
        const add = document.createElement("button");
        add.className = "ghost-button settings-source-action";
        add.type = "button";
        add.textContent = t("settingsAddRoot");
        add.addEventListener("click", () => {
          draft[key] = [...resolved.roots, ""];
          renderSources(payload);
          focusLastRootInput(container, key);
        });
        const disable = document.createElement("button");
        disable.className = "ghost-button settings-source-action";
        disable.type = "button";
        disable.textContent = t("settingsDisableSource");
        disable.addEventListener("click", () => {
          draft[key] = [];
          renderSources(payload);
        });
        actions.append(add, disable);
        block.append(list, protection, actions);
      } else {
        if (sourceState === "disabled") {
          const disabled = document.createElement("p");
          disabled.className = "settings-source-disabled";
          disabled.textContent = t("settingsSourceDisabled");
          block.append(disabled);
        } else {
          const hint = document.createElement("p");
          hint.className = "settings-source-note";
          hint.textContent = t(
            protectedRoots.size
              ? "settingsProtectedRootsRetained"
              : "settingsCustomRootsHint"
          );
          const list = document.createElement("div");
          list.className = "settings-root-editor";
          custom.forEach((root, index) => {
            const row = document.createElement("div");
            row.className = "settings-root-row";
            if (protectedRoots.has(root)) {
              row.classList.add("settings-root-protected");
              const value = document.createElement("code");
              value.className = "settings-root-protected-value";
              value.textContent = root;
              value.title = root;
              const protectedLabel = document.createElement("span");
              protectedLabel.className = "settings-root-protected-label";
              protectedLabel.textContent = t("settingsProtectedRoot");
              row.append(value, protectedLabel);
            } else {
              const input = document.createElement("input");
              input.type = "text";
              input.value = root;
              input.spellcheck = false;
              input.placeholder = t("settingsRootPlaceholder");
              input.addEventListener("input", () => {
                draft[key][index] = input.value;
              });
              row.append(input);
              if (protectedRoots.size > 0 || customRoots.length > 1) {
                const remove = document.createElement("button");
                remove.className = "ghost-button settings-root-remove";
                remove.type = "button";
                remove.textContent = t("settingsRemoveRoot");
                remove.addEventListener("click", () => {
                  draft[key].splice(index, 1);
                  renderSources(payload);
                });
                row.append(remove);
              }
            }
            list.append(row);
          });
          block.append(hint, list);
        }
        const actions = document.createElement("div");
        actions.className = "settings-source-actions";
        const add = document.createElement("button");
        add.className = "ghost-button settings-source-action";
        add.type = "button";
        add.textContent = t(
          sourceState === "disabled"
            ? "settingsEnableSource"
            : "settingsAddRoot"
        );
        add.addEventListener("click", () => {
          if (sourceState === "disabled") {
            draft[key] = [""];
          } else {
            draft[key].push("");
          }
          renderSources(payload);
          focusLastRootInput(container, key);
        });
        actions.append(add);
        if (sourceState !== "disabled") {
          const disable = document.createElement("button");
          disable.className = "ghost-button settings-source-action";
          disable.type = "button";
          disable.textContent = t("settingsDisableSource");
          disable.addEventListener("click", () => {
            draft[key] = [];
            renderSources(payload);
          });
          actions.append(disable);
        }
        const restore = document.createElement("button");
        restore.className = "ghost-button settings-source-action";
        restore.type = "button";
        restore.textContent = t("settingsRestoreDefault");
        restore.addEventListener("click", () => {
          draft[key] = null;
          renderSources(payload);
        });
        actions.append(restore);
        block.append(actions);
      }
      appendSourceHealth(block, payload?.diagnostics?.sources?.[key]);
      block.dataset.kind = key;
      container.append(block);
    });
  }

  function formatDiagnosticTime(value) {
    if (!value) return t("settingsNeverScanned");
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t("settingsNeverScanned");
    return new Intl.DateTimeFormat(getLang() === "zh" ? "zh-CN" : "en", {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(date);
  }

  function renderDiagnostics(payload) {
    const recovery = payload?.recovery || { required: false };
    if (elements.settingsRecovery) {
      elements.settingsRecovery.classList.toggle("hidden", !recovery.required);
    }
    if (elements.settingsRecoveryMessage) {
      elements.settingsRecoveryMessage.textContent = recovery.message || "";
    }
    const watcher = payload?.watcher || { active: false, root_count: 0 };
    if (elements.settingsDiagnosticsMeta) {
      const watcherLabel = watcher.active
        ? t("settingsWatcherActive", { n: watcher.root_count || 0 })
        : t("settingsWatcherInactive");
      elements.settingsDiagnosticsMeta.textContent = `${t("settingsLastScan")}: ${formatDiagnosticTime(payload?.diagnostics?.last_scan_at)} · ${watcherLabel}`;
      elements.settingsDiagnosticsMeta.title = watcher.last_error || "";
    }
  }

  function renderStorage(payload) {
    const cache = payload?.cache || { enabled: false };
    if (elements.settingsCachePath) {
      elements.settingsCachePath.textContent = cache.enabled
        ? cache.path
        : t("settingsCacheDisabled");
      elements.settingsCachePath.title = cache.enabled ? cache.path : "";
    }
    if (elements.settingsCacheSize) {
      elements.settingsCacheSize.textContent = cache.enabled
        ? formatBytes(cache.bytes)
        : "—";
    }
    if (elements.settingsClearCache) {
      elements.settingsClearCache.disabled = !cache.enabled;
    }
    const backup = payload?.deletion_backup || { enabled: false };
    if (elements.settingsDeletionBackupPath) {
      elements.settingsDeletionBackupPath.textContent = backup.enabled
        ? backup.path
        : t("settingsBackupUnavailable");
      elements.settingsDeletionBackupPath.title = backup.enabled
        ? backup.path
        : "";
    }
    if (elements.settingsDeletionBackupCount) {
      elements.settingsDeletionBackupCount.textContent = backup.enabled
        ? String(backup.count || 0)
        : "—";
    }
    const workspace = payload?.workspace_storage || { enabled: false };
    if (elements.settingsWorkspacePath) {
      elements.settingsWorkspacePath.textContent = workspace.enabled
        ? workspace.path
        : t("settingsWorkspaceUnavailable");
      elements.settingsWorkspacePath.title = workspace.enabled
        ? workspace.path
        : "";
    }
    if (elements.settingsWorkspaceCount) {
      elements.settingsWorkspaceCount.textContent = workspace.enabled
        ? t("settingsWorkspaceSummary", {
            sessions: workspace.session_count || 0,
            filters: workspace.saved_filter_count || 0,
          })
        : "—";
    }
  }

  function renderPreferences(payload) {
    const preferences = payload?.preferences;
    if (!preferences) return;
    savedPreferences = {
      keep_running_in_tray: preferences.keep_running_in_tray !== false,
      check_updates_on_startup: preferences.check_updates_on_startup !== false,
    };
    if (elements.settingsKeepRunning) {
      elements.settingsKeepRunning.checked =
        savedPreferences.keep_running_in_tray;
    }
    if (elements.settingsStartupUpdates) {
      elements.settingsStartupUpdates.checked =
        savedPreferences.check_updates_on_startup;
    }
  }

  function setPreferenceControlsDisabled(disabled) {
    if (elements.settingsKeepRunning) {
      elements.settingsKeepRunning.disabled = disabled;
    }
    if (elements.settingsStartupUpdates) {
      elements.settingsStartupUpdates.disabled = disabled;
    }
  }

  function applyPayload(payload) {
    latestPayload = payload;
    draft = { ...(payload?.sources || {}) };
    renderSources(payload);
    renderStorage(payload);
    renderPreferences(payload);
    renderDiagnostics(payload);
    if (elements.settingsVersion) {
      elements.settingsVersion.textContent = payload?.version || "-";
    }
    if (payload?.recovery?.required) activateTab("sources");
  }

  async function open(tab = null) {
    const target = dialog();
    if (!target) return;
    if (tab) activeTab = tab;
    setStatus("");
    if (elements.settingsLanguageSelect) {
      elements.settingsLanguageSelect.value = getLang();
    }
    if (!target.open) target.showModal();
    lockPageScroll();
    activateTab(activeTab);
    if (elements.settingsSaveBtn) elements.settingsSaveBtn.disabled = true;
    setPreferenceControlsDisabled(true);
    if (elements.settingsCheckUpdate)
      elements.settingsCheckUpdate.disabled = true;
    try {
      applyPayload(await fetchJson("/api/settings"));
      if (elements.settingsSaveBtn) elements.settingsSaveBtn.disabled = false;
      setPreferenceControlsDisabled(false);
      if (elements.settingsCheckUpdate)
        elements.settingsCheckUpdate.disabled = false;
    } catch (error) {
      setStatus(
        error.code === DESKTOP_RUNTIME_REQUIRED
          ? t("settingsDesktopPreview")
          : error.message,
        error.code !== DESKTOP_RUNTIME_REQUIRED
      );
    }
  }

  async function copyDiagnostics() {
    if (!latestPayload) return;
    const sources = Object.fromEntries(
      Object.entries(latestPayload.diagnostics?.sources || {}).map(
        ([key, value]) => [
          key,
          {
            enabled: value.enabled,
            declared_roots: value.declared_roots,
            available_roots: value.available_roots,
            discovered_files: value.discovered_files,
            indexed_sessions: value.indexed_sessions,
            error_count: value.error_count,
          },
        ]
      )
    );
    const diagnostic = {
      app: "AllSessions",
      version: latestPayload.version,
      platform: navigator.platform || "unknown",
      language: getLang(),
      recovery_required: latestPayload.recovery?.required === true,
      last_scan_at: latestPayload.diagnostics?.last_scan_at || null,
      watcher: {
        active: latestPayload.watcher?.active === true,
        root_count: latestPayload.watcher?.root_count || 0,
        has_error: Boolean(latestPayload.watcher?.last_error),
      },
      sources,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2));
      setStatus(t("settingsDiagnosticsCopied"));
    } catch {
      setStatus(t("settingsDiagnosticsCopyFailed"), true);
    }
  }

  async function savePreferences() {
    if (!savedPreferences) return;
    const next = {
      keep_running_in_tray: elements.settingsKeepRunning?.checked !== false,
      check_updates_on_startup:
        elements.settingsStartupUpdates?.checked !== false,
    };
    setPreferenceControlsDisabled(true);
    setStatus(t("settingsSaving"));
    try {
      const payload = await fetchJson("/api/settings/preferences", {
        method: "POST",
        body: { preferences: next },
      });
      renderPreferences(payload);
      setStatus(t("settingsPreferencesSaved"));
    } catch (error) {
      renderPreferences({ preferences: savedPreferences });
      setStatus(error.message, true);
    } finally {
      setPreferenceControlsDisabled(false);
    }
  }

  async function save() {
    if (!draft) return;
    if (elements.settingsSaveBtn) elements.settingsSaveBtn.disabled = true;
    setStatus(t("settingsSaving"));
    try {
      const payload = await fetchJson("/api/settings", {
        method: "POST",
        body: { sources: draft },
      });
      applyPayload(payload);
      setStatus(t("settingsSaved"));
      onSaved?.();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      if (elements.settingsSaveBtn) elements.settingsSaveBtn.disabled = false;
    }
  }

  async function clearCache() {
    if (elements.settingsClearCache)
      elements.settingsClearCache.disabled = true;
    setStatus(t("settingsCacheClearing"));
    try {
      const payload = await fetchJson("/api/settings/clear-cache", {
        method: "POST",
      });
      renderStorage(payload);
      setStatus(t("settingsCacheCleared"));
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      if (elements.settingsClearCache)
        elements.settingsClearCache.disabled = false;
    }
  }

  async function checkForUpdates() {
    if (elements.settingsCheckUpdate)
      elements.settingsCheckUpdate.disabled = true;
    setStatus("");
    try {
      await fetchJson("/api/settings/check-update", { method: "POST" });
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      if (elements.settingsCheckUpdate)
        elements.settingsCheckUpdate.disabled = false;
    }
  }

  async function openExternalLink(event) {
    if (!window.__TAURI__?.core?.invoke) return;
    event.preventDefault();
    try {
      await openUrl(event.currentTarget.href);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  }

  function bind() {
    elements.settingsToggle?.addEventListener("click", () => open());
    elements.settingsCloseBtn?.addEventListener("click", () =>
      dialog()?.close()
    );
    dialog()?.addEventListener("close", unlockPageScroll);
    dialog()?.addEventListener("click", (event) => {
      if (event.target === dialog()) dialog().close();
    });
    elements.settingsSaveBtn?.addEventListener("click", save);
    elements.settingsClearCache?.addEventListener("click", clearCache);
    elements.settingsCopyDiagnostics?.addEventListener(
      "click",
      copyDiagnostics
    );
    elements.settingsCheckUpdate?.addEventListener("click", checkForUpdates);
    elements.settingsRepositoryLink?.addEventListener(
      "click",
      openExternalLink
    );
    elements.settingsLicenseLink?.addEventListener("click", openExternalLink);
    elements.settingsKeepRunning?.addEventListener("change", savePreferences);
    elements.settingsStartupUpdates?.addEventListener(
      "change",
      savePreferences
    );
    elements.settingsTabs?.forEach((tab, index) => {
      tab.addEventListener("click", () => activateTab(tab.dataset.settingsTab));
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        let next = index;
        if (event.key === "ArrowLeft") {
          next =
            (index - 1 + elements.settingsTabs.length) %
            elements.settingsTabs.length;
        }
        if (event.key === "ArrowRight")
          next = (index + 1) % elements.settingsTabs.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = elements.settingsTabs.length - 1;
        activateTab(elements.settingsTabs[next].dataset.settingsTab, true);
      });
    });
    elements.settingsLanguageSelect?.addEventListener("change", (event) => {
      setLang(event.target.value === "en" ? "en" : "zh");
      onLanguageChanged?.();
      if (latestPayload) {
        renderSources(latestPayload);
        renderStorage(latestPayload);
        renderDiagnostics(latestPayload);
      }
    });
  }

  return { bind, open };
}
