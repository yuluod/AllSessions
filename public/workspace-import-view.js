import { t } from "./i18n.js";

export function reviewWorkspaceMatches(preview) {
  const dialog = document.querySelector("#workspace-matches-dialog");
  const form = dialog.querySelector("form");
  const skipped = dialog.querySelector("textarea");
  const fields = dialog.querySelector("#workspace-match-options");
  const limit = dialog.querySelector("#workspace-match-limit");
  const choices = new Map();
  fields.replaceChildren();
  limit.hidden = !preview.omitted_candidates;
  limit.textContent = t("settingsWorkspaceMatchLimit", preview);
  skipped.value = preview.unmatched_keys
    .filter((key) => !Object.hasOwn(preview.ambiguous, key))
    .join("\n");
  skipped.closest("label").hidden = !skipped.value;
  for (const [key, candidates] of Object.entries(preview.ambiguous)) {
    const label = document.createElement("label");
    const name = document.createElement("span");
    name.textContent = key;
    const select = document.createElement("select");
    select.append(
      new Option(t("settingsWorkspaceSkipMatch"), ""),
      ...candidates.map(
        ({ key: target, title, cwd }) =>
          new Option([title, cwd, target].filter(Boolean).join(" · "), target)
      )
    );
    label.append(name, select);
    fields.append(label);
    choices.set(key, select);
  }
  return new Promise((resolve) => {
    dialog.returnValue = "";
    form.onsubmit = (event) => {
      event.preventDefault();
      if (event.submitter.value === "continue") {
        const targets = new Set();
        for (const select of choices.values()) {
          if (!select.value) continue;
          if (targets.has(select.value)) {
            select.setCustomValidity(t("settingsWorkspaceDuplicateMatch"));
            select.reportValidity();
            select.setCustomValidity("");
            return;
          }
          targets.add(select.value);
        }
      }
      dialog.close(event.submitter.value);
    };
    dialog.addEventListener(
      "close",
      () => {
        const selected = Object.fromEntries(
          [...choices].flatMap(([key, select]) =>
            select.value ? [[key, select.value]] : []
          )
        );
        fields.replaceChildren();
        skipped.value = "";
        resolve(dialog.returnValue === "continue" ? selected : null);
      },
      { once: true }
    );
    dialog.showModal();
  });
}
