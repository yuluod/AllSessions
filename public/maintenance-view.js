import { createLatestRequestGate, isAbortError } from "./async-coordinator.js";
import { t } from "./i18n.js";
import { deriveMaintenanceState } from "./maintenance-state.js";
import { formatCount } from "./session-format.js";

function queryElements(root) {
  return {
    toolsDashboard: root.querySelector("#tools-dashboard"),
    toolsNavItems: Array.from(root.querySelectorAll(".tools-nav-item")),
    toolsPanels: Array.from(root.querySelectorAll(".tools-panel")),
    rollbackDashboard: root.querySelector("#codex-rollback-dashboard"),
    openRollbackBtn: root.querySelector("#open-codex-rollback-btn"),
    rollbackBackBtn: root.querySelector("#codex-rollback-back-btn"),
    rollbackCard: root.querySelector(".codex-rollback-card"),
    rollbackMaintenanceToggle: root.querySelector(
      "#codex-rollback-maintenance-toggle"
    ),
    rollbackStatus: root.querySelector("#codex-rollback-status"),
    migrationCard: root.querySelector("#codex-migration-card"),
    maintenanceToggle: root.querySelector("#codex-maintenance-toggle"),
    previewBtn: root.querySelector("#codex-migration-preview-btn"),
    applyBtn: root.querySelector("#codex-migration-apply-btn"),
    rollbackBtn: root.querySelector("#codex-migration-rollback-btn"),
    confirm: root.querySelector("#codex-migration-confirm"),
    status: root.querySelector("#codex-migration-status"),
    threadCount: root.querySelector("#codex-migration-thread-count"),
    jsonlCount: root.querySelector("#codex-migration-jsonl-count"),
    replacementCount: root.querySelector("#codex-migration-replacement-count"),
    diagnostics: root.querySelector("#codex-migration-diagnostics"),
    metrics: root.querySelector("#codex-migration-metrics"),
    nextStep: root.querySelector("#codex-migration-next-step"),
    workflow: root.querySelector("#codex-migration-workflow"),
    steps: Array.from(
      root.querySelectorAll("#codex-migration-workflow .maintenance-step")
    ),
    complete: root.querySelector("#codex-migration-complete"),
    finishBtn: root.querySelector("#codex-migration-finish-btn"),
    staleNotice: root.querySelector("#codex-migration-plan-stale"),
    currentProvider: root.querySelector("#codex-migration-current-provider"),
    targetProvider: root.querySelector("#codex-migration-target-provider"),
    diagnosticList: root.querySelector("#codex-migration-diagnostic-list"),
    providerList: root.querySelector("#codex-migration-provider-list"),
    rollbackDir: root.querySelector("#codex-migration-rollback-dir"),
    rollbackConfirm: root.querySelector("#codex-migration-rollback-confirm"),
    backupNotice: root.querySelector("#codex-migration-backup-notice"),
    backupLabel: root.querySelector("#codex-migration-backup-label"),
    backupPath: root.querySelector("#codex-migration-backup-path"),
  };
}

export function createMaintenanceController({
  requestJson,
  refreshData,
  root = document,
} = {}) {
  const elements = queryElements(root);
  const previewRequestGate = createLatestRequestGate();
  const state = {
    enabled: false,
    preview: null,
    selectedProviders: new Set(),
    applied: false,
    busy: false,
    allowMaintenanceToggle: false,
    bound: false,
  };

  function selectedProviders() {
    return Array.from(state.selectedProviders).sort();
  }

  function currentFlowState() {
    return deriveMaintenanceState({
      enabled: state.enabled,
      preview: state.preview,
      selectedProviders: selectedProviders(),
      confirmed: elements.confirm?.checked === true,
      applied: state.applied,
      busy: state.busy,
      allowMaintenanceToggle: state.allowMaintenanceToggle,
    });
  }

  function setStatus(message, kind = "") {
    if (!elements.status) return;
    elements.status.textContent = message;
    elements.status.dataset.kind = kind;
  }

  function setRollbackStatus(message, kind = "") {
    if (!elements.rollbackStatus) return;
    elements.rollbackStatus.textContent = message;
    elements.rollbackStatus.dataset.kind = kind;
  }

  function syncFlowState() {
    const flow = currentFlowState();
    if (elements.metrics) {
      elements.metrics.dataset.stale = String(flow.stale);
    }
    if (elements.diagnostics) {
      elements.diagnostics.dataset.stale = String(flow.stale);
    }
    elements.staleNotice?.classList.toggle("hidden", !flow.stale);

    if (elements.workflow) elements.workflow.dataset.phase = flow.phase;
    elements.steps.forEach((step, index) => {
      const stepNumber = index + 1;
      step.dataset.state =
        stepNumber < flow.activeStep
          ? "complete"
          : stepNumber === flow.activeStep
            ? "active"
            : "pending";
    });
    elements.complete?.classList.toggle("hidden", !state.applied);
    elements.previewBtn?.classList.toggle("hidden", state.applied);
    elements.confirm
      ?.closest(".migration-actions")
      ?.classList.toggle("hidden", state.applied);

    if (elements.previewBtn) {
      elements.previewBtn.textContent = t(flow.previewButtonKey);
      elements.previewBtn.disabled = flow.controls.previewDisabled;
    }
    if (elements.nextStep) {
      elements.nextStep.textContent = t(flow.nextStepKey);
    }
    if (elements.applyBtn) {
      elements.applyBtn.disabled = flow.controls.applyDisabled;
    }
    if (elements.rollbackBtn) {
      elements.rollbackBtn.disabled = flow.controls.rollbackDisabled;
    }
    if (elements.confirm) {
      elements.confirm.disabled = flow.controls.confirmDisabled;
    }
    if (elements.rollbackConfirm) {
      elements.rollbackConfirm.disabled = flow.controls.rollbackConfirmDisabled;
    }
    if (elements.rollbackDir) {
      elements.rollbackDir.disabled = flow.controls.rollbackDirDisabled;
    }
    if (elements.finishBtn) {
      elements.finishBtn.disabled = flow.controls.finishDisabled;
    }
    [elements.maintenanceToggle, elements.rollbackMaintenanceToggle].forEach(
      (toggle) => {
        if (toggle) {
          toggle.disabled = flow.controls.maintenanceToggleDisabled;
        }
      }
    );
  }

  function configureUi() {
    const enabled = state.enabled;
    if (elements.migrationCard) {
      elements.migrationCard.dataset.enabled = String(enabled);
    }
    if (elements.rollbackCard) {
      elements.rollbackCard.dataset.enabled = String(enabled);
    }
    if (elements.maintenanceToggle) {
      elements.maintenanceToggle.checked = enabled;
    }
    if (elements.rollbackMaintenanceToggle) {
      elements.rollbackMaintenanceToggle.checked = enabled;
    }
    if (!enabled) {
      if (elements.providerList) {
        elements.providerList.textContent = t("maintenanceDisabledHint");
      }
      setStatus(t("maintenanceDisabled"), "warning");
      setRollbackStatus(t("rollbackMaintenanceDisabled"), "warning");
    } else {
      if (!state.preview) setStatus(t("migrationNotPreviewed"));
      setRollbackStatus(t("rollbackReady"));
    }
    syncFlowState();
  }

  function setBusy(isBusy, { allowMaintenanceToggle = false } = {}) {
    state.busy = isBusy;
    state.allowMaintenanceToggle = isBusy && allowMaintenanceToggle;
    syncFlowState();
  }

  function resetMetrics() {
    [
      elements.threadCount,
      elements.jsonlCount,
      elements.replacementCount,
    ].forEach((element) => {
      if (element) element.textContent = "-";
    });
    if (elements.currentProvider) elements.currentProvider.textContent = "-";
    if (elements.targetProvider) elements.targetProvider.textContent = "-";
    elements.diagnosticList?.replaceChildren();
    if (elements.diagnostics) elements.diagnostics.dataset.kind = "neutral";
    elements.backupNotice?.classList.add("hidden");
    if (elements.providerList) {
      elements.providerList.textContent = t("migrationNoPreview");
    }
    syncFlowState();
  }

  function renderDiagnostics(summary) {
    if (elements.currentProvider) {
      elements.currentProvider.textContent =
        summary.codexConfig?.activeProvider || "-";
    }
    if (elements.targetProvider) {
      elements.targetProvider.textContent = summary.targetProvider || "-";
    }
    if (!elements.diagnosticList || !elements.diagnostics) return;

    const list = elements.diagnosticList;
    list.replaceChildren();
    const blockers = summary.blockers || [];
    const warnings = summary.warnings || [];
    if (blockers.length) {
      const selectionOnly = blockers.every(
        (item) => item.code === "source_provider_selection_required"
      );
      elements.diagnostics.dataset.kind = selectionOnly ? "warning" : "error";
      blockers.forEach((item) => {
        const row = document.createElement("li");
        row.textContent = selectionOnly
          ? t("migrationSelectProviders")
          : t("migrationBlocker", { message: item.message });
        list.append(row);
      });
      return;
    }
    elements.diagnostics.dataset.kind = warnings.length ? "warning" : "ok";
    if (!warnings.length) {
      const row = document.createElement("li");
      row.textContent = t("migrationReady");
      list.append(row);
      return;
    }
    warnings.forEach((item) => {
      const row = document.createElement("li");
      const message =
        item.code === "current_provider_only"
          ? t("migrationCurrentProviderOnly", {
              target: summary.targetProvider || "-",
            })
          : item.message;
      row.textContent = t("migrationWarning", { message });
      list.append(row);
    });
  }

  function renderPreview(summary) {
    state.preview = summary;
    if (!summary) {
      resetMetrics();
      return;
    }

    if (elements.threadCount) {
      elements.threadCount.textContent = formatCount(summary.threadMatches);
    }
    if (elements.jsonlCount) {
      elements.jsonlCount.textContent = formatCount(summary.jsonlFilesToChange);
    }
    if (elements.replacementCount) {
      elements.replacementCount.textContent = formatCount(
        summary.jsonlSessionMetaReplacements
      );
    }
    renderDiagnostics(summary);

    if (elements.providerList) {
      elements.providerList.replaceChildren();
      const mappings = summary.candidateMappings || summary.mappings || [];
      const candidateProviders = new Set(
        mappings.map((mapping) => mapping.source)
      );
      for (const provider of selectedProviders()) {
        if (!candidateProviders.has(provider)) {
          state.selectedProviders.delete(provider);
        }
      }
      if (!mappings.length) {
        elements.providerList.textContent = t("migrationNoProviders");
      } else {
        mappings.forEach((mapping) => {
          const item = document.createElement("label");
          item.className = "migration-provider-item";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = state.selectedProviders.has(mapping.source);
          checkbox.disabled = !state.enabled || state.applied;
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
              state.selectedProviders.add(mapping.source);
            } else {
              state.selectedProviders.delete(mapping.source);
            }
            state.applied = false;
            if (elements.confirm) elements.confirm.checked = false;
            setStatus(
              state.selectedProviders.size > 0
                ? t("migrationSelectionChanged")
                : t("migrationSelectProviders"),
              "warning"
            );
            syncFlowState();
          });
          const name = document.createElement("span");
          name.textContent = `${mapping.source} → ${mapping.target}`;
          const count = document.createElement("strong");
          count.textContent = t("migrationMappingCounts", {
            threads: formatCount(mapping.threads),
            jsonl: formatCount(mapping.jsonl),
          });
          item.append(checkbox, name, count);
          elements.providerList.append(item);
        });
      }
    }

    if (summary.backupDir && elements.rollbackDir) {
      elements.rollbackDir.value = summary.backupDir;
    }
    if (elements.backupNotice) {
      if (summary.backupDir) {
        if (elements.backupLabel) {
          elements.backupLabel.textContent = t("backupSavedAt");
        }
        if (elements.backupPath) {
          elements.backupPath.textContent = summary.backupDir;
        }
        elements.backupNotice.classList.remove("hidden");
        elements.backupNotice.dataset.done = "true";
      } else if (summary.backupRoot) {
        if (elements.backupLabel) {
          elements.backupLabel.textContent = t("backupWillSaveTo");
        }
        if (elements.backupPath) {
          elements.backupPath.textContent = `${summary.backupRoot}/${summary.migration || "codex-history-provider-rebucket-v2"}/`;
        }
        elements.backupNotice.classList.remove("hidden");
        elements.backupNotice.dataset.done = "false";
      } else {
        elements.backupNotice.classList.add("hidden");
      }
    }
    syncFlowState();
  }

  async function toggleMaintenance(event) {
    const enabled =
      event?.currentTarget?.checked ??
      elements.maintenanceToggle?.checked === true;
    if (!enabled) previewRequestGate.cancel();
    [elements.maintenanceToggle, elements.rollbackMaintenanceToggle].forEach(
      (toggle) => {
        if (toggle) toggle.disabled = true;
      }
    );
    try {
      const result = await requestJson("/api/codex-maintenance", {
        method: "POST",
        mutation: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      state.enabled = result.enabled === true;
      state.preview = null;
      state.selectedProviders.clear();
      state.applied = false;
      state.busy = false;
      state.allowMaintenanceToggle = false;
      if (elements.confirm) elements.confirm.checked = false;
      if (elements.rollbackConfirm) elements.rollbackConfirm.checked = false;
      resetMetrics();
      configureUi();
    } catch (error) {
      console.error(error);
      state.busy = false;
      state.allowMaintenanceToggle = false;
      configureUi();
      const message = `${t("maintenanceToggleFailed")}: ${error.message}`;
      setStatus(message, "error");
      setRollbackStatus(message, "error");
    } finally {
      [elements.maintenanceToggle, elements.rollbackMaintenanceToggle].forEach(
        (toggle) => {
          if (toggle) toggle.disabled = false;
        }
      );
    }
  }

  async function loadPreview() {
    if (!state.enabled) {
      configureUi();
      return;
    }
    if (state.applied) return;
    const request = previewRequestGate.begin();
    setBusy(true, { allowMaintenanceToggle: true });
    setStatus(t("migrationPreviewing"));
    try {
      const providers = selectedProviders();
      const params = new URLSearchParams();
      if (providers.length > 0) params.set("providers", providers.join(","));
      const query = params.toString();
      const summary = await requestJson(
        `/api/codex-provider-migration/preview${query ? `?${query}` : ""}`,
        { signal: request.signal }
      );
      if (!request.isCurrent() || !state.enabled) return;
      state.applied = false;
      renderPreview(summary);
      if (summary.selectionRequired) {
        setStatus(t("migrationSelectProviders"), "warning");
      } else if (!summary.canApply) {
        setStatus(
          t("migrationPreviewBlocked", { n: summary.blockers?.length || 0 }),
          "error"
        );
      } else if (!summary.hasChanges) {
        setStatus(t("migrationNoChanges"), "ok");
      } else {
        setStatus(
          t("migrationPreviewReady", {
            n: summary.providers?.length || 0,
            target: summary.targetProvider || "-",
          }),
          "ok"
        );
      }
    } catch (error) {
      if (isAbortError(error) || !request.isCurrent()) return;
      console.error(error);
      setStatus(`${t("migrationPreviewFailed")}: ${error.message}`, "error");
    } finally {
      if (request.isCurrent()) setBusy(false);
    }
  }

  async function applyMigration() {
    if (!state.enabled) {
      configureUi();
      return;
    }
    if (elements.confirm?.checked !== true) {
      setStatus(t("migrationNeedConfirm"), "error");
      syncFlowState();
      return;
    }

    setBusy(true);
    state.applied = false;
    setStatus(t("migrationApplying"));
    try {
      const preview = state.preview;
      if (!preview?.planId) {
        setStatus(t("migrationNoPreview"), "error");
        return;
      }
      const summary = await requestJson("/api/codex-provider-migration/apply", {
        method: "POST",
        mutation: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmedCodexAppClosed: true,
          planId: preview.planId,
          providers: preview.providers,
        }),
      });
      state.applied = true;
      state.selectedProviders.clear();
      renderPreview(summary);
      state.preview = null;
      if (elements.providerList) {
        elements.providerList.textContent = t("migrationCompletedSources");
      }
      if (elements.confirm) elements.confirm.checked = false;
      setStatus(
        summary.backupDir
          ? t("migrationAppliedWithBackup", { path: summary.backupDir })
          : t("migrationApplied"),
        "ok"
      );
      await refreshData();
    } catch (error) {
      console.error(error);
      renderPreview(null);
      setStatus(`${t("migrationApplyFailed")}: ${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function rollbackMigration() {
    if (!state.enabled) {
      configureUi();
      return;
    }
    const backupDir = elements.rollbackDir?.value.trim();
    if (!backupDir) {
      setRollbackStatus(t("migrationNeedBackupDir"), "error");
      return;
    }
    if (elements.rollbackConfirm?.checked !== true) {
      setRollbackStatus(t("migrationNeedConfirm"), "error");
      return;
    }

    setBusy(true);
    setRollbackStatus(t("migrationRollbacking"));
    try {
      const result = await requestJson(
        "/api/codex-provider-migration/rollback",
        {
          method: "POST",
          mutation: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ backupDir, confirmedCodexAppClosed: true }),
        }
      );
      if (elements.rollbackConfirm) elements.rollbackConfirm.checked = false;
      state.applied = false;
      state.selectedProviders.clear();
      await refreshData();
      await loadPreview();
      setRollbackStatus(
        t("migrationRollbackDone", {
          sqlite: result.restoredSqlite,
          jsonl: result.restoredJsonl,
        }),
        "ok"
      );
    } catch (error) {
      console.error(error);
      setRollbackStatus(
        `${t("migrationRollbackFailed")}: ${error.message}`,
        "error"
      );
    } finally {
      setBusy(false);
    }
  }

  function openRollbackView() {
    elements.toolsDashboard?.classList.add("hidden");
    elements.rollbackDashboard?.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function closeRollbackView() {
    elements.rollbackDashboard?.classList.add("hidden");
    elements.toolsDashboard?.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function setToolsNavActive(item) {
    elements.toolsNavItems.forEach((navItem) => {
      const active = navItem === item;
      navItem.classList.toggle("active", active);
      if (active) {
        navItem.setAttribute("aria-current", "true");
      } else {
        navItem.removeAttribute("aria-current");
      }
    });
  }

  function showToolsPanel(item) {
    const target = item?.dataset.toolsTarget;
    if (!target) return;

    const panelId = target.replace(/^#/, "");
    elements.toolsPanels?.forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.toolsPanel === panelId);
    });
    setToolsNavActive(item);
    elements.toolsDashboard?.scrollTo({ top: 0, behavior: "auto" });
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    elements.previewBtn?.addEventListener("click", loadPreview);
    elements.maintenanceToggle?.addEventListener("change", toggleMaintenance);
    elements.rollbackMaintenanceToggle?.addEventListener(
      "change",
      toggleMaintenance
    );
    elements.openRollbackBtn?.addEventListener("click", openRollbackView);
    elements.rollbackBackBtn?.addEventListener("click", closeRollbackView);
    elements.toolsNavItems.forEach((item) => {
      item.addEventListener("click", () => showToolsPanel(item));
    });
    elements.finishBtn?.addEventListener("click", async () => {
      if (!elements.maintenanceToggle) return;
      elements.maintenanceToggle.checked = false;
      await toggleMaintenance();
    });
    elements.confirm?.addEventListener("change", syncFlowState);
    elements.applyBtn?.addEventListener("click", applyMigration);
    elements.rollbackBtn?.addEventListener("click", rollbackMigration);
    resetMetrics();
    configureUi();
  }

  function setCapabilities(capabilities) {
    state.enabled = capabilities?.codex_maintenance?.enabled === true;
    configureUi();
  }

  function renderLocalized() {
    if (state.preview) renderPreview(state.preview);
    else resetMetrics();
    configureUi();
  }

  return {
    bind,
    renderLocalized,
    setCapabilities,
  };
}
