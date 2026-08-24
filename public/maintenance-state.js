export function sameProviderSelection(left, right) {
  const first = Array.isArray(left) ? [...left].sort() : [];
  const second = Array.isArray(right) ? [...right].sort() : [];
  return (
    first.length === second.length &&
    first.every((provider, index) => provider === second[index])
  );
}

export function deriveMaintenanceState({
  enabled = false,
  preview = null,
  selectedProviders = [],
  confirmed = false,
  applied = false,
  busy = false,
  allowMaintenanceToggle = false,
} = {}) {
  const selected = Array.isArray(selectedProviders)
    ? [...selectedProviders].sort()
    : [];
  const mappings = preview?.candidateMappings || preview?.mappings || [];
  const stale =
    preview !== null && !sameProviderSelection(selected, preview.providers);

  let phase = "disabled";
  let activeStep = 1;
  if (applied) {
    phase = "complete";
    activeStep = 5;
  } else if (enabled) {
    if (!preview || selected.length === 0 || stale) {
      phase = preview ? "select" : "scan";
      activeStep = 2;
    } else if (!preview.canApply || !preview.hasChanges) {
      phase = "review";
      activeStep = 3;
    } else {
      phase = "execute";
      activeStep = 4;
    }
  }

  let previewButtonKey = "scanHistoricalProviders";
  if (applied) {
    previewButtonKey = "migrationCompleteTitle";
  } else if (preview && selected.length > 0) {
    previewButtonKey = "rebuildRepairPlan";
  } else if (preview && mappings.length > 0) {
    previewButtonKey = "buildExactRepairPlan";
  } else if (preview) {
    previewButtonKey = "rebuildRepairPlan";
  }

  let nextStepKey = "nextStepEnableMaintenance";
  if (enabled) {
    if (applied) {
      nextStepKey = "nextStepRepairDone";
    } else if (!preview) {
      nextStepKey = "nextStepScanProviders";
    } else if (selected.length === 0 && mappings.length > 0) {
      nextStepKey = "nextStepSelectProviders";
    } else if (stale) {
      nextStepKey = "nextStepRebuildPlan";
    } else if (!preview.canApply) {
      nextStepKey = "nextStepResolveBlockers";
    } else if (!preview.hasChanges) {
      nextStepKey = "nextStepNoChanges";
    } else if (!confirmed) {
      nextStepKey = "nextStepConfirmClosed";
    } else {
      nextStepKey = "nextStepApplyPlan";
    }
  }

  const canApply =
    enabled &&
    !applied &&
    confirmed &&
    selected.length > 0 &&
    !stale &&
    preview?.canApply === true &&
    preview?.hasChanges === true &&
    Boolean(preview?.planId);

  return {
    stale,
    phase,
    activeStep,
    previewButtonKey,
    nextStepKey,
    controls: {
      maintenanceToggleDisabled: busy && !allowMaintenanceToggle,
      previewDisabled: busy || !enabled,
      applyDisabled: busy || !canApply,
      rollbackDisabled: busy || !enabled,
      confirmDisabled: busy || !enabled || applied,
      rollbackConfirmDisabled: busy || !enabled,
      rollbackDirDisabled: busy || !enabled,
      finishDisabled: busy || !enabled || !applied,
    },
  };
}
