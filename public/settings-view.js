import { t, getLang, setLang } from "./i18n.js";
import { fetchJson } from "./api-client.js";

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

  function dialog() {
    return elements.settingsDialog;
  }

  function setStatus(message, isError = false) {
    if (!elements.settingsStatus) return;
    elements.settingsStatus.textContent = message;
    elements.settingsStatus.dataset.state = isError ? "error" : "info";
  }

  function focusLastRootInput(container, key) {
    const inputs = container.querySelectorAll(
      `.settings-source[data-kind="${key}"] input`
    );
    inputs[inputs.length - 1]?.focus();
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
      block.dataset.kind = key;
      container.append(block);
    });
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
  }

  function applyPayload(payload) {
    draft = { ...(payload?.sources || {}) };
    renderSources(payload);
    renderStorage(payload);
    if (elements.settingsVersion) {
      elements.settingsVersion.textContent = payload?.version || "-";
    }
  }

  async function open() {
    const target = dialog();
    if (!target) return;
    setStatus("");
    if (elements.settingsLanguageSelect) {
      elements.settingsLanguageSelect.value = getLang();
    }
    target.showModal();
    try {
      applyPayload(await fetchJson("/api/settings"));
    } catch (error) {
      setStatus(error.message, true);
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

  function bind() {
    elements.settingsToggle?.addEventListener("click", open);
    elements.settingsCloseBtn?.addEventListener("click", () =>
      dialog()?.close()
    );
    dialog()?.addEventListener("click", (event) => {
      if (event.target === dialog()) dialog().close();
    });
    elements.settingsSaveBtn?.addEventListener("click", save);
    elements.settingsClearCache?.addEventListener("click", clearCache);
    elements.settingsLanguageSelect?.addEventListener("change", (event) => {
      setLang(event.target.value === "en" ? "en" : "zh");
      onLanguageChanged?.();
    });
  }

  return { bind, open };
}
