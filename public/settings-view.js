import { t, getLang, setLang, translateBackendError } from "./i18n.js";
import {
  DESKTOP_RUNTIME_REQUIRED,
  fetchJson as requestJson,
} from "./api-client.js";
import { getThemeState, setScheme, setTheme } from "./theme-manager.js";
import { open as openPathDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

const SOURCE_KINDS = [
  { key: "codex", agent: "codex", label: "Codex" },
  { key: "codex_archived", agent: "codex", label: "Codex Archived" },
  { key: "claude", agent: "claude", label: "Claude Code" },
  { key: "claude_cowork", agent: "claude", label: "Claude Cowork" },
  { key: "gemini", agent: "gemini", label: "Gemini CLI" },
  { key: "grok", agent: "grok", label: "Grok Build" },
  { key: "pi", agent: "pi", label: "Pi" },
  { key: "kimi", agent: "kimi", label: "Kimi Code CLI" },
  { key: "opencode", agent: "opencode", label: "OpenCode" },
  { key: "kilo", agent: "kilo", label: "Kilo" },
  { key: "zcode", agent: "zcode", label: "ZCode" },
  { key: "cursor", agent: "cursor", label: "Cursor" },
  { key: "devin", agent: "devin", label: "Devin" },
  { key: "copilot", agent: "copilot", label: "GitHub Copilot" },
  { key: "hermes", agent: "hermes", label: "Hermes Agent" },
  { key: "vscode_copilot", agent: "copilot", label: "VS Code Copilot Chat" },
];

export function summarizeSourceSupport(payload) {
  const supported = new Set(SOURCE_KINDS.map(({ agent }) => agent)).size;
  const detected = new Set(
    SOURCE_KINDS.filter(({ key }) => {
      const diagnostic = payload?.diagnostics?.sources?.[key];
      return diagnostic?.enabled && (diagnostic.available_roots || 0) > 0;
    }).map(({ agent }) => agent)
  ).size;
  return { supported, detected };
}

// 路径数组必须复制，避免编辑草稿同时改变已保存的基线。
export function cloneSourceSettings(sources = {}) {
  return Object.fromEntries(
    Object.entries(sources).map(([key, roots]) => [
      key,
      roots === null ? null : [...roots],
    ])
  );
}

export function hasSourceChanges(draft, saved) {
  return [
    ...new Set([...Object.keys(draft || {}), ...Object.keys(saved || {})]),
  ].some((key) => {
    const next = draft?.[key] ?? null;
    const previous = saved?.[key] ?? null;
    return JSON.stringify(next) !== JSON.stringify(previous);
  });
}

export function sourceHealthState(diagnostic) {
  if (typeof diagnostic?.enabled !== "boolean") return "unknown";
  if (!diagnostic.enabled) return "disabled";
  if ((diagnostic.error_count || 0) > 0) return "warning";
  if ((diagnostic.unsupported_count || 0) > 0) return "unsupported";
  if ((diagnostic.available_roots || 0) === 0) return "missing";
  return "ready";
}

function sourceText(key, directoryKey, databaseKey) {
  return t(
    ["opencode", "kilo", "zcode"].includes(key) ? databaseKey : directoryKey
  );
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function fetchJson(url, options) {
  return requestJson(url, options, { translateCode: translateBackendError });
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
  let savedSources = null;
  let savingSources = false;
  let loading = false;
  let loadVersion = 0;
  let discardPending = false;

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

  function syncDraftState() {
    const dirty = hasSourceChanges(draft, savedSources);
    if (!dirty) discardPending = false;
    dialog()?.setAttribute("data-dirty", String(dirty));
    dialog()?.setAttribute("data-discard-pending", String(discardPending));
    if (elements.settingsSaveBtn)
      elements.settingsSaveBtn.disabled =
        loading ||
        savingSources ||
        !draft ||
        (!dirty && !latestPayload?.recovery?.required);
    if (elements.settingsUnsavedHint)
      elements.settingsUnsavedHint.textContent = dirty
        ? t("settingsUnsavedSources")
        : "";
    if (elements.settingsDiscardPrompt)
      elements.settingsDiscardPrompt.hidden = !discardPending;
    if (elements.settingsDiscardChanges)
      elements.settingsDiscardChanges.disabled = savingSources;
    // 输入过程中只刷新概览提示，不重建输入框或打断光标。
    for (const card of elements.settingsSources?.querySelectorAll(
      ".settings-source-card"
    ) || []) {
      const key = card.dataset.key;
      const pending = hasSourceChanges(
        { [key]: draft?.[key] },
        { [key]: savedSources?.[key] }
      );
      card.dataset.pending = String(pending);
      const badge = card.querySelector(".settings-card-health");
      if (badge)
        badge.textContent = pending
          ? t("settingsPendingSource")
          : sourceHealthLabel(card.dataset.state);
    }
  }

  function close() {
    if (sourceConfigDialogEl?.open) {
      sourceConfigDialogEl.close();
      return;
    }
    if (savingSources) return;
    if (loading) {
      loadVersion += 1;
      loading = false;
      dialog()?.close();
      return;
    }
    if (hasSourceChanges(draft, savedSources)) {
      discardPending = true;
      syncDraftState();
      elements.settingsKeepEditing?.focus();
      return;
    }
    dialog()?.close();
  }

  function syncAppearance() {
    const state = getThemeState();
    elements.settingsThemeInputs?.forEach((input) => {
      input.checked = input.value === state.theme;
    });
    elements.settingsSchemeInputs?.forEach((input) => {
      input.checked = input.value === state.scheme;
    });
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

  function focusLastRootInput() {
    const inputs = sourceConfigDialogEl.querySelectorAll(
      ".settings-root-row input"
    );
    inputs[inputs.length - 1]?.focus();
  }

  function sourceHealthLabel(state) {
    return t(`settingsSourceHealth_${state}`);
  }

  function sourceErrorText(key, error) {
    if (key === "opencode") return t("settingsOpenCodeReadFailed");
    if (key === "kilo") return t("settingsKiloReadFailed");
    if (key === "zcode") return t("settingsZCodeReadFailed");
    return error;
  }

  // 渲染逐条原因的折叠列表：每条「文件名 + 原因」，超出展示上限时提示剩余数量。
  function appendDiagnosticEntries(
    block,
    title,
    entries,
    total,
    itemClassName,
    hint = ""
  ) {
    if (!Array.isArray(entries) || !entries.length) return;
    const details = document.createElement("details");
    details.className = "settings-source-entries";
    const summary = document.createElement("summary");
    summary.textContent = title;
    details.append(summary);
    if (hint) {
      const note = document.createElement("p");
      note.className = "settings-entries-hint";
      note.textContent = hint;
      details.append(note);
    }
    const list = document.createElement("ul");
    for (const entry of entries) {
      const item = document.createElement("li");
      item.className = itemClassName;
      const path = document.createElement("span");
      path.className = "settings-entry-path";
      path.textContent = entry.path || "";
      path.title = entry.path || "";
      if (entry.session_id) {
        path.textContent += ` · ${entry.session_id}`;
        path.title = path.textContent;
      }
      const message = document.createElement("span");
      message.className = "settings-entry-message";
      message.textContent = entry.message || "";
      item.append(path, message);
      list.append(item);
    }
    const hidden = Number(total || 0) - entries.length;
    if (hidden > 0) {
      const more = document.createElement("li");
      more.className = "settings-entry-more";
      more.textContent = t("settingsEntriesMore", { n: hidden });
      list.append(more);
    }
    details.append(list);
    block.append(details);
  }

  async function chooseSourcePath(key, currentPath) {
    if (!window.__TAURI__?.core?.invoke) {
      setStatus(t("settingsDesktopPreview"));
      return null;
    }
    const database = ["opencode", "kilo", "zcode"].includes(key);
    try {
      return await openPathDialog({
        title: sourceText(key, "settingsChooseRoot", "settingsChooseDatabase"),
        defaultPath: currentPath || undefined,
        directory: !database,
        multiple: false,
        ...(database
          ? {
              filters: [
                {
                  name: "SQLite",
                  extensions: ["db", "sqlite", "sqlite3"],
                },
              ],
            }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`${t("settingsChoosePathFailed")}: ${message}`, true);
      return null;
    }
  }

  function appendSourceHealth(block, key, diagnostic) {
    const state = sourceHealthState(diagnostic);
    const health = document.createElement("div");
    health.className = "settings-source-health";
    health.dataset.state = state;
    const badge = document.createElement("span");
    badge.className = "settings-health-badge";
    badge.textContent = sourceHealthLabel(state);
    const summary = document.createElement("span");
    summary.textContent = t("settingsSourceHealthSummary", {
      sessions: diagnostic?.indexed_sessions || 0,
      files: diagnostic?.discovered_files || 0,
    });
    health.append(badge, summary);
    const errorCount = diagnostic?.error_count || 0;
    const unsupportedCount = diagnostic?.unsupported_count || 0;
    if (errorCount > 0 || unsupportedCount > 0) {
      const counts = document.createElement("span");
      counts.className = "settings-source-counts";
      const parts = [];
      if (errorCount > 0)
        parts.push(t("settingsErrorCount", { n: errorCount }));
      if (unsupportedCount > 0)
        parts.push(t("settingsUnsupportedCount", { n: unsupportedCount }));
      counts.textContent = parts.join(" · ");
      health.append(counts);
    }
    if (diagnostic?.last_error) {
      const error = document.createElement("span");
      error.className = "settings-source-error";
      error.textContent = sourceErrorText(key, diagnostic.last_error);
      error.title = diagnostic.last_error;
      health.append(error);
    }
    block.append(health);
    // 逐条原因集中在设置里：损坏记录与暂不支持的记录分开列出。
    appendDiagnosticEntries(
      block,
      t("settingsErrorEntriesTitle"),
      diagnostic?.error_entries,
      errorCount,
      "settings-entry-error"
    );
    appendDiagnosticEntries(
      block,
      t("settingsUnsupportedEntriesTitle"),
      diagnostic?.unsupported_entries,
      unsupportedCount,
      "settings-entry-unsupported",
      t("settingsUnsupportedHint")
    );
  }

  function renderSources(payload) {
    const overview = summarizeSourceSupport(payload);
    if (elements.settingsSourceOverview) {
      const supported = document.createElement("strong");
      supported.textContent = t("settingsSupportedAgents", {
        n: overview.supported,
      });
      const detected = document.createElement("span");
      detected.textContent = t("settingsDetectedAgents", {
        n: overview.detected,
      });
      elements.settingsSourceOverview.replaceChildren(supported, detected);
      elements.settingsSourceOverview.classList.remove("hidden");
    }
    const container = elements.settingsSources;
    if (!container) return;
    container.replaceChildren();

    // 概览网格：紧凑卡片（图标 + 名称 + 来源徽章），点击打开目录编辑弹窗。
    const grid = document.createElement("div");
    grid.className = "settings-source-grid";

    SOURCE_KINDS.forEach(({ key, label, agent }) => {
      const source = sourceSnapshot(payload, key);
      const card = document.createElement("button");
      card.type = "button";
      card.dataset.key = key;
      card.dataset.sourceAgent = agent;
      card.className = "settings-source-card";
      card.setAttribute("aria-haspopup", "dialog");
      const icon = document.createElement("span");
      icon.className = "source-tree__dot";
      const name = document.createElement("strong");
      name.textContent = label;
      const origin = document.createElement("span");
      origin.className = "settings-origin";
      origin.dataset.origin = source.originKey;
      origin.textContent = t(`settingsOrigin_${source.originKey}`);
      const diagnostic = payload?.diagnostics?.sources?.[key];
      card.dataset.state = sourceHealthState(diagnostic);
      const metadata = document.createElement("span");
      metadata.className = "settings-source-card-meta";
      const health = document.createElement("span");
      health.className = "settings-card-health";
      const count = document.createElement("span");
      metadata.append(health);
      if (typeof diagnostic?.indexed_sessions === "number") {
        count.textContent = t("settingsIndexedSessions", {
          n: diagnostic.indexed_sessions,
        });
        metadata.append(count);
      }
      card.append(icon, name, origin, metadata);
      card.addEventListener("click", () => {
        openSourceConfigDialog(payload, key, label);
      });
      grid.append(card);
    });

    container.append(grid);
    syncDraftState();
  }

  function sourceSnapshot(payload, key) {
    const custom = draft?.[key] ?? null;
    const resolved = (custom === null ? payload?.inherited?.[key] : null) ||
      payload?.resolved?.[key] || {
        roots: [],
        origin: "default",
      };
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
    return {
      resolved,
      custom,
      sourceState,
      originKey,
      protectedRoots,
      customRoots,
    };
  }

  let sourceConfigDialogEl = null;

  // 单来源目录编辑弹窗：从概览卡片打开，修改暂存到草稿，由外层统一保存。
  function openSourceConfigDialog(payload, key, label) {
    if (!sourceConfigDialogEl || !sourceConfigDialogEl.isConnected) {
      sourceConfigDialogEl = document.createElement("dialog");
      sourceConfigDialogEl.className = "delete-dialog settings-source-dialog";
      sourceConfigDialogEl.setAttribute(
        "aria-labelledby",
        "settings-source-dialog-title"
      );
      sourceConfigDialogEl.addEventListener("close", () => {
        elements.settingsSources
          ?.querySelector(
            `[data-key="${sourceConfigDialogEl.dataset.sourceKey}"]`
          )
          ?.focus();
      });
      document.body.append(sourceConfigDialogEl);
    }
    sourceConfigDialogEl.dataset.sourceKey = key;
    const source = sourceSnapshot(payload, key);
    const refresh = () => {
      renderSources(payload);
      openSourceConfigDialog(payload, key, label);
    };

    const header = document.createElement("div");
    header.className = "delete-dialog-header";
    const title = document.createElement("h2");
    title.id = "settings-source-dialog-title";
    title.textContent = label;
    const origin = document.createElement("span");
    origin.className = "settings-origin";
    origin.dataset.origin = source.originKey;
    origin.textContent = t(`settingsOrigin_${source.originKey}`);
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "ghost-button delete-dialog-close-button";
    closeButton.setAttribute("aria-label", t("closeSettings"));
    const closeSvg = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg"
    );
    closeSvg.setAttribute("viewBox", "0 0 24 24");
    closeSvg.setAttribute("width", "18");
    closeSvg.setAttribute("height", "18");
    closeSvg.setAttribute("fill", "none");
    const closePath = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path"
    );
    closePath.setAttribute("d", "M6 6l12 12M18 6L6 18");
    closePath.setAttribute("stroke", "currentColor");
    closePath.setAttribute("stroke-width", "1.8");
    closePath.setAttribute("stroke-linecap", "round");
    closeSvg.append(closePath);
    closeButton.append(closeSvg);
    closeButton.addEventListener("click", () => sourceConfigDialogEl.close());
    header.append(title, origin, closeButton);

    const body = document.createElement("div");
    body.className = "delete-dialog-body";

    sourceConfigDialogEl.replaceChildren(header, body);
    sourceConfigDialogEl.showModal();
    buildSourceEditor({ payload, key, source, body, refresh });
    const footer = document.createElement("div");
    footer.className = "settings-source-dialog-footer";
    const hint = document.createElement("span");
    hint.textContent = t("settingsSourceDraftHint");
    const done = document.createElement("button");
    done.className = "ghost-button";
    done.type = "button";
    done.textContent = t("settingsSourceDone");
    done.addEventListener("click", () => sourceConfigDialogEl.close());
    footer.append(hint, done);
    sourceConfigDialogEl.append(footer);
  }

  // 编辑器内容填充进传入的 body；refresh 用于修改后同步概览与弹窗自身。
  function buildSourceEditor({ payload, key, source, body, refresh }) {
    const { resolved, custom, sourceState, protectedRoots, customRoots } =
      source;
    const summary = document.createElement("div");
    summary.className = "settings-source-dialog-meta";
    appendSourceHealth(summary, key, payload?.diagnostics?.sources?.[key]);
    body.append(summary);

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
      add.textContent = sourceText(
        key,
        "settingsAddRoot",
        "settingsAddDatabase"
      );
      add.addEventListener("click", () => {
        draft[key] = [...resolved.roots, ""];
        refresh();
        focusLastRootInput();
      });
      const disable = document.createElement("button");
      disable.className = "ghost-button settings-source-action";
      disable.type = "button";
      disable.textContent = t("settingsDisableSource");
      disable.addEventListener("click", () => {
        draft[key] = [];
        refresh();
      });
      actions.append(add, disable);
      body.append(list, protection, actions);
    } else {
      if (sourceState === "disabled") {
        const disabled = document.createElement("p");
        disabled.className = "settings-source-disabled";
        disabled.textContent = t("settingsSourceDisabled");
        body.append(disabled);
      } else {
        const hint = document.createElement("p");
        hint.className = "settings-source-note";
        hint.textContent = protectedRoots.size
          ? t("settingsProtectedRootsRetained")
          : sourceText(
              key,
              "settingsCustomRootsHint",
              "settingsCustomDatabaseHint"
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
            input.setAttribute(
              "aria-label",
              sourceText(key, "settingsChooseRoot", "settingsChooseDatabase")
            );
            input.placeholder = sourceText(
              key,
              "settingsRootPlaceholder",
              "settingsDatabasePlaceholder"
            );
            input.addEventListener("input", () => {
              draft[key][index] = input.value;
              syncDraftState();
            });
            row.append(input);
            const choose = document.createElement("button");
            choose.className = "ghost-button settings-root-pick";
            choose.type = "button";
            choose.textContent = sourceText(
              key,
              "settingsChooseRoot",
              "settingsChooseDatabase"
            );
            choose.addEventListener("click", async () => {
              const selected = await chooseSourcePath(key, input.value);
              if (!selected) return;
              draft[key][index] = selected;
              input.value = selected;
              syncDraftState();
            });
            row.append(choose);
            if (protectedRoots.size > 0 || customRoots.length > 1) {
              const remove = document.createElement("button");
              remove.className = "ghost-button settings-root-remove";
              remove.type = "button";
              remove.textContent = sourceText(
                key,
                "settingsRemoveRoot",
                "settingsRemoveDatabase"
              );
              remove.addEventListener("click", () => {
                draft[key].splice(index, 1);
                refresh();
              });
              row.append(remove);
            }
          }
          list.append(row);
        });
        body.append(hint, list);
      }
      const actions = document.createElement("div");
      actions.className = "settings-source-actions";
      const add = document.createElement("button");
      add.className = "ghost-button settings-source-action";
      add.type = "button";
      add.textContent =
        sourceState === "disabled"
          ? sourceText(key, "settingsEnableSource", "settingsEnableDatabase")
          : sourceText(key, "settingsAddRoot", "settingsAddDatabase");
      add.addEventListener("click", () => {
        if (sourceState === "disabled") {
          draft[key] = [""];
        } else {
          draft[key].push("");
        }
        refresh();
        focusLastRootInput();
      });
      actions.append(add);
      const restore = document.createElement("button");
      restore.className = "ghost-button settings-source-action";
      restore.type = "button";
      restore.textContent = t("settingsRestoreDefault");
      restore.addEventListener("click", () => {
        draft[key] = null;
        refresh();
      });
      actions.append(restore);
      if (sourceState !== "disabled") {
        const disable = document.createElement("button");
        disable.className = "ghost-button settings-source-action";
        disable.type = "button";
        disable.textContent = t("settingsDisableSource");
        disable.addEventListener("click", () => {
          draft[key] = [];
          refresh();
        });
        actions.append(disable);
      }
      body.append(actions);
    }
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
      terminal_app: preferences.terminal_app || "auto",
      terminal_custom: preferences.terminal_custom || "",
    };
    if (elements.settingsKeepRunning) {
      elements.settingsKeepRunning.checked =
        savedPreferences.keep_running_in_tray;
    }
    if (elements.settingsStartupUpdates) {
      elements.settingsStartupUpdates.checked =
        savedPreferences.check_updates_on_startup;
    }
    if (elements.settingsTerminalApp) {
      const options = (payload?.terminal_options || []).filter(
        ({ value, installed }) =>
          installed !== false || value === savedPreferences.terminal_app
      );
      elements.settingsTerminalApp.replaceChildren(
        ...options.map(({ value, label }) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent =
            value === "auto"
              ? t("settingsTerminalAuto")
              : value === "custom"
                ? t("settingsTerminalCustomOption")
                : label;
          return option;
        })
      );
      elements.settingsTerminalApp.value = savedPreferences.terminal_app;
      elements.settingsTerminalApp
        .closest(".settings-general-row")
        ?.classList.toggle("hidden", options.length === 0);
    }
    syncTerminalCustomPick();
  }

  // 选中“自定义”时显示选择按钮；已选路径时按钮上显示应用名。
  function syncTerminalCustomPick() {
    const pick = elements.settingsTerminalCustomPick;
    if (!pick) return;
    const isCustom = elements.settingsTerminalApp?.value === "custom";
    pick.classList.toggle("hidden", !isCustom);
    const path = savedPreferences?.terminal_custom || "";
    pick.textContent = path
      ? customTerminalName(path)
      : t("settingsTerminalCustomPick");
    pick.title = path;
  }

  function customTerminalName(path) {
    const base = path.split(/[\\/]/).pop() || path;
    return base.endsWith(".app") ? base.slice(0, -4) : base;
  }

  function setPreferenceControlsDisabled(disabled) {
    if (elements.settingsKeepRunning) {
      elements.settingsKeepRunning.disabled = disabled;
    }
    if (elements.settingsStartupUpdates) {
      elements.settingsStartupUpdates.disabled = disabled;
    }
    if (elements.settingsTerminalApp) {
      elements.settingsTerminalApp.disabled = disabled;
    }
    if (elements.settingsTerminalCustomPick) {
      elements.settingsTerminalCustomPick.disabled = disabled;
    }
  }

  function applyPayload(payload) {
    latestPayload = payload;
    savedSources = cloneSourceSettings(payload?.sources);
    draft = cloneSourceSettings(savedSources);
    discardPending = false;
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
    if (target.open) {
      activateTab(activeTab);
      return;
    }
    loading = true;
    const requestVersion = ++loadVersion;
    setStatus("");
    if (elements.settingsLanguageSelect) {
      elements.settingsLanguageSelect.value = getLang();
    }
    syncAppearance();
    if (!target.open) target.showModal();
    lockPageScroll();
    activateTab(activeTab);
    if (elements.settingsSaveBtn) elements.settingsSaveBtn.disabled = true;
    setPreferenceControlsDisabled(true);
    if (elements.settingsCheckUpdate)
      elements.settingsCheckUpdate.disabled = true;
    try {
      const payload = await fetchJson("/api/settings");
      // 关闭或重新打开后，旧请求不能覆盖当前表单和草稿。
      if (requestVersion !== loadVersion || !target.open) return;
      applyPayload(payload);
      setPreferenceControlsDisabled(false);
      if (elements.settingsCheckUpdate)
        elements.settingsCheckUpdate.disabled = false;
    } catch (error) {
      if (requestVersion !== loadVersion || !target.open) return;
      setStatus(
        error.code === DESKTOP_RUNTIME_REQUIRED
          ? t("settingsDesktopPreview")
          : error.message,
        error.code !== DESKTOP_RUNTIME_REQUIRED
      );
    } finally {
      if (requestVersion === loadVersion) {
        loading = false;
        syncDraftState();
      }
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
      terminal_app:
        elements.settingsTerminalApp?.value ||
        savedPreferences.terminal_app ||
        "auto",
      terminal_custom: savedPreferences.terminal_custom ?? "",
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
    if (
      !draft ||
      savingSources ||
      (!hasSourceChanges(draft, savedSources) &&
        !latestPayload?.recovery?.required)
    )
      return;
    savingSources = true;
    syncDraftState();
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
      savingSources = false;
      syncDraftState();
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

  // 重新扫描：整体扫描或索引构建失败后的显式重试入口。
  // 扫描期间状态栏会经 sessions-changed 事件恢复进度轮询。
  async function rescanSources() {
    if (elements.settingsRescan) elements.settingsRescan.disabled = true;
    setStatus(t("settingsRescanning"));
    try {
      await fetchJson("/api/refresh");
      latestPayload = await fetchJson("/api/settings");
      renderSources(latestPayload);
      renderDiagnostics(latestPayload);
      setStatus(t("settingsRescanDone"));
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      if (elements.settingsRescan) elements.settingsRescan.disabled = false;
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
    elements.settingsCloseBtn?.addEventListener("click", close);
    dialog()?.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    elements.settingsKeepEditing?.addEventListener("click", () => {
      discardPending = false;
      syncDraftState();
      activateTab("sources", true);
    });
    elements.settingsDiscardChanges?.addEventListener("click", () => {
      if (savingSources) return;
      draft = cloneSourceSettings(savedSources);
      discardPending = false;
      syncDraftState();
      dialog()?.close();
    });
    dialog()?.addEventListener("close", unlockPageScroll);
    dialog()?.addEventListener("click", (event) => {
      if (event.target === dialog()) close();
    });
    elements.settingsSaveBtn?.addEventListener("click", save);
    elements.settingsClearCache?.addEventListener("click", clearCache);
    elements.settingsRescan?.addEventListener("click", rescanSources);
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
    elements.settingsTerminalApp?.addEventListener("change", () => {
      syncTerminalCustomPick();
      savePreferences();
    });
    elements.settingsTerminalCustomPick?.addEventListener("click", async () => {
      if (!window.__TAURI__?.core?.invoke) {
        setStatus(t("settingsDesktopPreview"));
        return;
      }
      try {
        const selected = await openPathDialog({
          title: t("settingsTerminalCustomPick"),
          defaultPath: savedPreferences?.terminal_custom || undefined,
          directory: false,
          multiple: false,
        });
        if (selected && savedPreferences) {
          savedPreferences.terminal_custom = selected;
          syncTerminalCustomPick();
          savePreferences();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`${t("settingsChoosePathFailed")}: ${message}`, true);
      }
    });
    elements.settingsThemeInputs?.forEach((input) => {
      input.addEventListener("change", (event) => {
        if (event.target.checked) setTheme(event.target.value);
      });
    });
    elements.settingsSchemeInputs?.forEach((input) => {
      input.addEventListener("change", (event) => {
        if (event.target.checked) setScheme(event.target.value);
      });
    });
    document.addEventListener("allsessions:themechange", syncAppearance);
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

  return { bind, open, close };
}
