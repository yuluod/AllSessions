import { t } from "./i18n.js";

export function requestBackupPassphrase(forDeletion = false) {
  const dialog = document.querySelector("#backup-passphrase-dialog");
  if (dialog.open) return Promise.resolve(null);
  const form = dialog.querySelector("form");
  const input = form.elements.passphrase;
  const repeat = form.elements.repeat;
  const submit = form.querySelector('button[type="submit"]');
  const cancel = form.querySelector('button[value="cancel"]');
  dialog.querySelector("h2").textContent = t(
    forDeletion ? "backupEncryptTitle" : "settingsDecryptBackup"
  );
  dialog.querySelector("p").textContent = t(
    forDeletion ? "backupEncryptPrompt" : "backupDecryptPrompt"
  );
  submit.textContent = t(
    forDeletion ? "backupEncryptDelete" : "settingsDecryptBackup"
  );
  repeat.closest("label").hidden = !forDeletion;
  repeat.disabled = !forDeletion;
  repeat.required = forDeletion;
  input.setCustomValidity("");
  repeat.setCustomValidity("");
  let submitted = null;
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  return new Promise((resolve) => {
    form.addEventListener(
      "input",
      () => {
        input.setCustomValidity("");
        repeat.setCustomValidity("");
      },
      options
    );
    form.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        if (
          !input.value.trim() ||
          new TextEncoder().encode(input.value).length > 1024
        ) {
          input.setCustomValidity(t("backupPassphraseInvalid"));
          input.reportValidity();
          return;
        }
        if (forDeletion && input.value !== repeat.value) {
          repeat.setCustomValidity(t("backupPassphraseMismatch"));
          repeat.reportValidity();
          return;
        }
        submitted = input.value;
        form.reset();
        dialog.close();
      },
      options
    );
    cancel.addEventListener("click", () => dialog.close(), options);
    dialog.addEventListener(
      "close",
      () => {
        listeners.abort();
        form.reset();
        resolve(submitted);
      },
      { ...options, once: true }
    );
    dialog.showModal();
    input.focus();
  });
}
