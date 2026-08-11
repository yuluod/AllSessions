let repairModulePromise = null;

function loadRepairModule() {
  if (!repairModulePromise) {
    repairModulePromise = import("../scripts/migrate-codex-provider-to-custom.mjs");
  }
  return repairModulePromise;
}

export async function previewCodexProviderRepair(options) {
  const { runMigration } = await loadRepairModule();
  return runMigration({ ...options, apply: false });
}

export async function applyCodexProviderRepair(options) {
  const { runMigration } = await loadRepairModule();
  return runMigration({ ...options, apply: true });
}

export async function rollbackCodexProviderRepair(options) {
  const { rollbackMigration } = await loadRepairModule();
  return rollbackMigration(options);
}
