import { t } from "./i18n.js";
import { progressPercent, shouldShowAvailableVersion } from "./update-state.js";

const BUSY_PHASES = new Set(["checking", "downloading", "installing"]);

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export function createUpdateController({ root = document, requestJson }) {
  const elements = {
    dialog: root.querySelector("#update-dialog"),
    close: root.querySelector("#update-dialog-close"),
    version: root.querySelector("#update-version"),
    notesSection: root.querySelector("#update-notes-section"),
    notes: root.querySelector("#update-notes"),
    status: root.querySelector("#update-status"),
    progressRegion: root.querySelector("#update-progress-region"),
    progress: root.querySelector("#update-progress"),
    progressLabel: root.querySelector("#update-progress-label"),
    cancel: root.querySelector("#update-cancel-btn"),
    primary: root.querySelector("#update-primary-btn"),
  };
  let current = { phase: "idle" };

  function isBusy() {
    return BUSY_PHASES.has(current.phase);
  }

  function open() {
    if (!elements.dialog?.open) elements.dialog?.showModal();
    document.documentElement.classList.add("update-modal-open");
  }

  function close() {
    if (isBusy()) return;
    elements.dialog?.close();
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
    const { phase, version = "", notes = "", message = "" } = current;
    const busy = isBusy();
    if (elements.version) {
      const showVersion = shouldShowAvailableVersion(phase, version);
      elements.version.textContent = showVersion
        ? t("updateVersion", { version })
        : "";
      elements.version.classList.toggle("hidden", !showVersion);
    }
    if (elements.notes) elements.notes.textContent = notes;
    elements.notesSection?.classList.toggle("hidden", !notes);
    if (elements.status) {
      const statusKey = {
        checking: "updateChecking",
        available: "updateAvailable",
        downloading: "updateDownloading",
        installing: "updateInstallingHint",
        latest: "updateLatest",
        error: "updateFailed",
      }[phase];
      elements.status.textContent =
        phase === "error" && message ? message : statusKey ? t(statusKey) : "";
      elements.status.dataset.state = phase === "error" ? "error" : phase;
    }
    setProgress(current);
    if (elements.close) elements.close.disabled = busy;
    if (elements.cancel) {
      elements.cancel.disabled = busy;
      elements.cancel.textContent = t(
        phase === "available" ? "updateLater" : "closeSettings"
      );
    }
    if (elements.primary) {
      const action =
        phase === "available" ? "install" : phase === "error" ? "retry" : "";
      elements.primary.dataset.action = action;
      elements.primary.textContent = t(
        action === "install" ? "updateInstall" : "updateRetry"
      );
      elements.primary.classList.toggle("hidden", !action);
      elements.primary.disabled = busy;
    }
  }

  function handleStatus(payload = {}) {
    current = { ...current, ...payload };
    if (payload.phase === "checking") current = { phase: "checking" };
    open();
    render();
  }

  async function runPrimaryAction() {
    const action = elements.primary?.dataset.action;
    try {
      if (action === "install") {
        current = {
          ...current,
          phase: "downloading",
          downloaded: 0,
          total: null,
        };
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
    elements.close?.addEventListener("click", close);
    elements.cancel?.addEventListener("click", close);
    elements.primary?.addEventListener("click", runPrimaryAction);
    elements.dialog?.addEventListener("cancel", (event) => {
      if (isBusy()) event.preventDefault();
    });
    elements.dialog?.addEventListener("close", () => {
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
