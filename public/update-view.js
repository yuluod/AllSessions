import { t } from "./i18n.js";
import { bindExternalLinks } from "./external-links.js";
import { renderMarkdown } from "./markdown.js";
import { progressPercent, shouldShowAvailableVersion } from "./update-state.js";

const BLOCKING_PHASES = new Set(["checking", "installing"]);

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export function createUpdateController({
  root = document,
  requestJson,
  announce,
}) {
  const elements = {
    dialog: root.querySelector("#update-dialog"),
    close: root.querySelector("#update-dialog-close"),
    version: root.querySelector("#update-version"),
    notesSection: root.querySelector("#update-notes-section"),
    notes: root.querySelector("#update-notes"),
    notesTruncated: root.querySelector("#update-notes-truncated"),
    status: root.querySelector("#update-status"),
    progressRegion: root.querySelector("#update-progress-region"),
    progress: root.querySelector("#update-progress"),
    progressLabel: root.querySelector("#update-progress-label"),
    cancel: root.querySelector("#update-cancel-btn"),
    primary: root.querySelector("#update-primary-btn"),
    settings: root.querySelector("#settings-dialog"),
    settingsResult: root.querySelector("#settings-update-result"),
    settingsResultText: root.querySelector("#settings-update-result-text"),
    settingsResultAction: root.querySelector("#settings-update-result-action"),
  };
  let current = { phase: "idle" };
  let renderedNotes;
  let linkError = "";
  let backgroundResult = false;

  function open() {
    if (!elements.dialog || elements.dialog.open) return;
    elements.dialog.showModal();
    document.documentElement.classList.add("update-modal-open");
  }

  function close() {
    if (BLOCKING_PHASES.has(current.phase)) return;
    if (elements.dialog?.open) elements.dialog.close();
  }

  function setProgress(payload) {
    const percent = progressPercent(payload.downloaded, payload.total);
    elements.progressRegion?.classList.toggle(
      "hidden",
      !["downloading", "installing"].includes(payload.phase)
    );
    if (!elements.progress || !elements.progressLabel) return;
    if (payload.phase === "installing") {
      elements.progress.value = 100;
      elements.progressLabel.textContent = t("updateInstalling");
      return;
    }
    if (percent === null) {
      elements.progress.removeAttribute("value");
      elements.progressLabel.textContent = t("updateDownloaded", {
        downloaded: formatBytes(payload.downloaded),
      });
      return;
    }
    elements.progress.value = percent;
    elements.progressLabel.textContent = t("updateDownloadProgress", {
      percent,
      downloaded: formatBytes(payload.downloaded),
      total: formatBytes(payload.total),
    });
  }

  function render() {
    const {
      phase,
      version = "",
      notes = "",
      notes_truncated,
      message = "",
    } = current;
    const blocking = BLOCKING_PHASES.has(phase);
    const failed = phase === "error" || phase === "install_error";
    if (elements.version) {
      const showVersion = shouldShowAvailableVersion(phase, version);
      elements.version.textContent = showVersion
        ? t("updateVersion", { version })
        : "";
      elements.version.classList.toggle("hidden", !showVersion);
    }
    if (elements.notes && notes !== renderedNotes) {
      renderMarkdown(elements.notes, notes);
      renderedNotes = notes;
    }
    elements.notesSection?.classList.toggle("hidden", !notes);
    elements.notesTruncated?.classList.toggle("hidden", !notes_truncated);
    if (elements.status) {
      const statusKey = {
        checking: "updateChecking",
        downloading: "updateDownloading",
        ready: "updateReady",
        installing: "updateInstallingHint",
        latest: "updateLatest",
        error: "updateFailed",
        install_error: "updateFailed",
      }[phase];
      const statusText =
        linkError ||
        (failed && message ? message : statusKey ? t(statusKey) : "");
      elements.status.textContent = statusText;
      elements.status.classList.toggle("hidden", !statusText);
      elements.status.dataset.state = linkError || failed ? "error" : phase;
    }
    if (elements.settingsResult && elements.settingsResultText) {
      const showResult = backgroundResult && ["ready", "error"].includes(phase);
      const resultText = showResult
        ? t(phase === "ready" ? "updateReady" : "updateFailed")
        : "";
      elements.settingsResult.hidden = !showResult;
      elements.settingsResult.dataset.state = phase;
      if (elements.settingsResultText.textContent !== resultText) {
        elements.settingsResultText.textContent = resultText;
      }
    }
    setProgress(current);
    const secondaryLabel =
      {
        available: "updateLater",
        downloading: "updateBackground",
      }[phase] || "closeSettings";
    if (elements.close) {
      elements.close.disabled = blocking;
      elements.close.setAttribute("aria-label", t(secondaryLabel));
    }
    if (elements.cancel) {
      elements.cancel.disabled = blocking;
      elements.cancel.textContent = t(secondaryLabel);
    }
    if (elements.primary) {
      const action =
        {
          available: "download",
          ready: "install",
          install_error: "install",
          error: "retry",
        }[phase] || "";
      elements.primary.dataset.action = action;
      elements.primary.textContent = action
        ? t(
            {
              download: "updateDownload",
              install:
                phase === "install_error"
                  ? "updateRetryInstall"
                  : "updateInstall",
              retry: "updateRetry",
            }[action]
          )
        : "";
      elements.primary.classList.toggle("hidden", !action);
    }
  }

  function handleStatus(payload = {}) {
    if (payload.phase === "show") {
      if (current.phase !== "idle") open();
      return;
    }
    const wasDownloading = current.phase === "downloading";
    if (payload.phase !== current.phase) linkError = "";
    current = { ...current, ...payload };
    if (payload.phase === "checking") current = { phase: "checking" };
    backgroundResult =
      wasDownloading &&
      !elements.dialog?.open &&
      ["ready", "error"].includes(payload.phase);
    render();
    if (payload.phase === "downloading") return;
    if (backgroundResult) {
      if (elements.settings?.open && elements.settingsResult) return;
      const result = current;
      announce(
        payload.phase === "ready" ? t("updateReady") : t("updateFailed"),
        {
          actionLabel: t("updateViewDetails"),
          onAction: () => {
            if (current === result) open();
          },
        }
      );
      return;
    }
    open();
  }

  async function runPrimaryAction() {
    const action = elements.primary?.dataset.action;
    try {
      linkError = "";
      if (action === "download") {
        current = {
          ...current,
          phase: "downloading",
          downloaded: 0,
          total: null,
        };
        render();
        await requestJson("/api/settings/download-update", { method: "POST" });
      } else if (action === "install") {
        current = { ...current, phase: "installing" };
        render();
        await requestJson("/api/settings/install-update", { method: "POST" });
      } else if (action === "retry") {
        current = { phase: "checking" };
        render();
        await requestJson("/api/settings/check-update", { method: "POST" });
      }
    } catch (error) {
      handleStatus({
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function bind() {
    bindExternalLinks(elements.notes, {
      open: async (url) => {
        await requestJson("/api/links/open", { method: "POST", body: { url } });
        if (linkError) {
          linkError = "";
          render();
        }
      },
      onError: (message) => {
        linkError = message;
        render();
      },
    });
    elements.close?.addEventListener("click", close);
    elements.cancel?.addEventListener("click", close);
    elements.primary?.addEventListener("click", runPrimaryAction);
    elements.settingsResultAction?.addEventListener("click", open);
    elements.dialog?.addEventListener("cancel", (event) => {
      if (BLOCKING_PHASES.has(current.phase)) event.preventDefault();
    });
    elements.dialog?.addEventListener("close", () => {
      if (!elements.dialog.open)
        document.documentElement.classList.remove("update-modal-open");
    });
    elements.dialog?.addEventListener("click", (event) => {
      if (event.target === elements.dialog) close();
    });

    const listen = window.__TAURI__?.event?.listen;
    if (typeof listen !== "function") return;
    await listen("update-status", (event) => handleStatus(event.payload));
    await requestJson("/api/settings/update-ready", { method: "POST" });
  }

  return { bind, handleStatus, renderLocalized: render };
}
