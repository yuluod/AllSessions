import { formatCount } from "./session-format.js";

const PRICE_FIELDS = ["input", "output", "cache_read", "cache_write"];

export function bindModelPrices({ getModels, requestJson, onSaved }) {
  const trigger = document.querySelector("#stats-unpriced-models");
  const dialog = document.querySelector("#model-price-dialog");
  const form = document.querySelector("#model-price-form");
  if (!trigger || !dialog || !form) return;
  const status = form.querySelector("#model-price-status");
  const select = form.elements.model;
  const cancel = form.querySelector("#model-price-cancel");
  const submit = form.querySelector('button[type="submit"]');
  let saving = false;

  trigger.addEventListener("click", () => {
    form.reset();
    status.textContent = "";
    select.replaceChildren(
      ...getModels().map(
        ({ label, count }) =>
          new Option(`${label} · ${formatCount(count)} Token`, label)
      )
    );
    if (select.options.length) dialog.showModal();
  });
  select.addEventListener("change", () => {
    for (const field of PRICE_FIELDS) form.elements[field].value = "";
    status.textContent = "";
  });
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => {
    if (saving) event.preventDefault();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    const body = {
      model: select.value,
      price: Object.fromEntries(
        PRICE_FIELDS.map((field) => [field, form.elements[field].valueAsNumber])
      ),
    };
    saving = true;
    for (const input of form.elements) input.disabled = true;
    status.textContent = "";
    try {
      await requestJson("/api/settings/model-price", { method: "POST", body });
      dialog.close();
      trigger.focus();
      await onSaved();
      if (
        trigger.hidden &&
        (document.activeElement === trigger ||
          document.activeElement === document.body)
      ) {
        document.querySelector("#stats-dashboard h2")?.focus();
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      saving = false;
      for (const input of form.elements) input.disabled = false;
      if (dialog.open) submit.focus();
    }
  });
}
