import { t } from "./i18n.js";

export function reviewWorkspaceConflicts(conflicts) {
  const dialog = document.querySelector("#workspace-conflicts-dialog");
  const form = dialog.querySelector("form");
  const fields = dialog.querySelector(".delete-dialog-body");
  const selections = conflicts.map(({ id, kind, key, local, incoming }) => {
    const field = document.createElement("fieldset");
    const label = document.createElement("legend");
    const choice = document.createElement("select");
    const comparison = document.createElement("details");
    const summary = document.createElement("summary");
    label.textContent = kind === "filter" ? `${incoming.name} (${key})` : key;
    choice.setAttribute("aria-label", label.textContent);
    choice.append(
      new Option(t("settingsWorkspaceKeepLocal"), ""),
      new Option(t("settingsWorkspaceUseImport"), id)
    );
    summary.textContent = t("settingsWorkspaceCompare");
    comparison.append(summary);
    comparison.addEventListener("toggle", () => {
      if (!comparison.open || comparison.children.length > 1) return;
      for (const [title, value] of [
        ["settingsWorkspaceLocalValue", local],
        ["settingsWorkspaceImportValue", incoming],
      ]) {
        const heading = document.createElement("strong");
        const content = document.createElement("pre");
        heading.textContent = t(title);
        content.textContent = JSON.stringify(value, null, 2);
        comparison.append(heading, content);
      }
    });
    field.append(label, choice, comparison);
    fields.append(field);
    return choice;
  });
  return new Promise((resolve) => {
    dialog.returnValue = "";
    form.onsubmit = (event) => {
      event.preventDefault();
      dialog.close(event.submitter.value);
    };
    dialog.addEventListener(
      "close",
      () => {
        const replacements = selections
          .map((choice) => choice.value)
          .filter(Boolean);
        fields.replaceChildren();
        resolve(dialog.returnValue === "continue" ? replacements : null);
      },
      { once: true }
    );
    dialog.showModal();
  });
}

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
