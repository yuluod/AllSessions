export async function openExportRules(fetchJson) {
  const dialog = document.querySelector("#export-rules-dialog");
  if (dialog.open) return;
  const settings = await fetchJson("/api/settings/export-redaction");
  if (dialog.open || !document.querySelector("#settings-dialog")?.open) return;
  const form = dialog.querySelector("form");
  const { enabled, patterns, sample, result } = form.elements;
  const status = form.querySelector("[role=status]");
  const test = form.querySelector(
    'button[data-i18n="settingsExportRulesTest"]'
  );
  const cancel = form.querySelector('button[value="cancel"]');
  const save = form.querySelector('button[type="submit"]');
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  let busy = false;
  enabled.checked = settings.enabled;
  patterns.value = settings.patterns.join("\n");
  status.textContent = "";

  function clearResult() {
    result.closest("label").hidden = true;
    result.value = "";
  }

  async function run(saveRules) {
    if (busy) return;
    const rules = {
      enabled: enabled.checked,
      patterns: patterns.value.split(/\r?\n/).filter((line) => line.trim()),
    };
    clearResult();
    status.textContent = "";
    busy = true;
    for (const field of form.elements) field.disabled = true;
    try {
      if (saveRules) {
        await fetchJson("/api/settings/export-redaction", {
          method: "POST",
          body: rules,
        });
        dialog.close();
      } else {
        result.value = await fetchJson("/api/settings/export-redaction/test", {
          method: "POST",
          body: { rules, sample: sample.value },
        });
        result.closest("label").hidden = false;
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      for (const field of form.elements) field.disabled = false;
      if (dialog.open) (saveRules ? save : test).focus();
    }
  }

  form.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      void run(true);
    },
    options
  );
  form.addEventListener("input", clearResult, options);
  test.addEventListener("click", () => void run(false), options);
  cancel.addEventListener("click", () => dialog.close(), options);
  dialog.addEventListener(
    "cancel",
    (event) => {
      if (busy) event.preventDefault();
    },
    options
  );
  dialog.addEventListener(
    "close",
    () => {
      listeners.abort();
      form.reset();
      clearResult();
      status.textContent = "";
    },
    { ...options, once: true }
  );
  dialog.showModal();
}
