import { t } from "./i18n.js";
import { statsPresetRange } from "./stats-calendar.js";

export function renderStatsRange(range, container, onChangeRange) {
  if (!container) return;
  container.replaceChildren();
  const start = range?.start || "";
  const end = range?.end || "";
  const rangeLabel =
    start || end
      ? `${start || t("statsRangeAnyStart")} — ${end || t("statsRangeAnyEnd")}`
      : t("statsRangeAll");
  const presets = document.createElement("div");
  presets.className = "stats-range-presets";
  presets.setAttribute("role", "group");
  presets.setAttribute("aria-label", t("statsRange"));
  presets.title = rangeLabel;
  for (const [preset, key] of [
    ["today", "statsRangeToday"],
    ["week", "statsRangeWeek"],
    ["month", "statsRangeMonth"],
    ["all", "statsRangeAll"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost-button";
    button.textContent = t(key);
    const expected = statsPresetRange(preset);
    button.setAttribute(
      "aria-pressed",
      String(start === expected.start && end === expected.end)
    );
    button.addEventListener("click", () => onChangeRange?.(expected));
    presets.append(button);
  }
  const custom = document.createElement("details");
  custom.className = "stats-range-custom";
  const summary = document.createElement("summary");
  summary.className = "ghost-button";
  summary.textContent = t("statsRangeChoose");
  summary.title = `${t("statsRangeCustom")} · ${rangeLabel}`;
  custom.append(summary);
  const form = document.createElement("form");
  form.className = "stats-range-form";
  form.setAttribute("aria-label", t("statsRangeCustom"));
  const inputs = {};
  for (const [field, key] of [
    ["start", "statsHeatmapStart"],
    ["end", "statsHeatmapEnd"],
  ]) {
    const wrapper = document.createElement("label");
    wrapper.textContent = t(key);
    const input = document.createElement("input");
    input.type = "date";
    input.value = field === "start" ? start : end;
    input.addEventListener("input", () => inputs.end.setCustomValidity(""));
    inputs[field] = input;
    wrapper.append(input);
    form.append(wrapper);
  }
  const apply = document.createElement("button");
  apply.type = "submit";
  apply.className = "ghost-button";
  apply.textContent = t("statsHeatmapApply");
  form.append(apply);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (
      inputs.start.value &&
      inputs.end.value &&
      inputs.start.value > inputs.end.value
    ) {
      inputs.end.setCustomValidity(t("statsHeatmapInvalidRange"));
      inputs.end.reportValidity();
      return;
    }
    onChangeRange?.({ start: inputs.start.value, end: inputs.end.value });
  });
  custom.append(form);
  container.append(presets, custom);
}
