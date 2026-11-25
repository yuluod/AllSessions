import { t } from "./i18n.js";

const MAX_WORKSPACE_FILE_BYTES = 16 * 1024 * 1024;

export async function importWorkspaceFile(
  file,
  { fetchJson, confirmWorkspaceImport, stillOpen, setStatus }
) {
  if (file.size > MAX_WORKSPACE_FILE_BYTES) {
    setStatus(t("settingsWorkspaceFileTooLarge"), true);
    return;
  }
  const body = { file: await file.text() };
  if (!stillOpen()) return;
  let preview = await fetchJson("/api/workspace/import/preview", {
    method: "POST",
    body,
  });
  if (!stillOpen()) return;
  if (preview.unmatched_keys?.length) {
    const choices = await reviewWorkspaceMatches(preview);
    if (!choices || !stillOpen()) return;
    if (Object.keys(choices).length) {
      body.choices = choices;
      preview = await fetchJson("/api/workspace/import/preview", {
        method: "POST",
        body,
      });
    }
  }
  if (!stillOpen()) return;
  if (preview.conflict_items?.length) {
    const replacements = await reviewWorkspaceConflicts(preview.conflict_items);
    if (!replacements || !stillOpen()) return;
    if (replacements.length) {
      body.replacements = replacements;
      preview = await fetchJson("/api/workspace/import/preview", {
        method: "POST",
        body: { ...body, previous_token: preview.token },
      });
    }
  }
  if (!stillOpen()) return;
  const summary = [
    t("settingsWorkspaceImportSummary", preview),
    preview.replaced ? t("settingsWorkspaceImportReplaced", preview) : "",
    preview.remapped ? t("settingsWorkspaceImportRemapped", preview) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  setStatus(summary);
  if (!preview.sessions && !preview.filters) return;
  const confirmed = await confirmWorkspaceImport(
    `${summary}\n\n${t("settingsWorkspaceImportBackup")}`,
    {
      title: t("settingsWorkspaceImport"),
      kind: "warning",
      okLabel: t("settingsWorkspaceImport"),
      cancelLabel: t("cancel"),
    }
  );
  if (confirmed !== true || !stillOpen()) return;
  setStatus(t("settingsWorkspaceImporting"));
  return fetchJson("/api/workspace/import", {
    method: "POST",
    body: { ...body, token: preview.token },
  });
}

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
