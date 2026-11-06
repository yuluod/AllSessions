import { t } from "./i18n.js";
import {
  formatCount,
  formatCost,
  formatListTimestamp,
} from "./session-format.js";
import { createEmptyState } from "./ui-components.js";

export function renderStatsSessionList(
  container,
  { data, sort = "recent", loading = false, error },
  { onSort, onMore, onRetry, onSelectSession }
) {
  if (!container) return;
  container.replaceChildren();
  const heading = document.createElement("div");
  heading.className = "stats-sessions-heading";
  const title = document.createElement("h3");
  title.textContent = t("statsRelatedSessions");
  const select = document.createElement("select");
  select.setAttribute("aria-label", t("statsSessionsSort"));
  for (const [value, label] of [
    ["recent", "searchRecent"],
    ["tokens", "statsSessionsMostTokens"],
    ["cost", "statsSessionsMostCost"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = t(label);
    select.append(option);
  }
  select.value = sort;
  select.disabled = loading;
  select.addEventListener("change", () => onSort(select.value));
  heading.append(title, select);
  const hint = document.createElement("p");
  hint.className = "stats-sessions-hint";
  hint.textContent = t("statsSessionsHint");
  container.append(heading, hint);
  const list = document.createElement("ol");
  list.className = "stats-session-list";
  for (const session of data?.sessions || []) {
    const item = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "stats-activity-link";
    open.textContent = session.title || session._key;
    open.addEventListener("click", () => onSelectSession(session._key));
    const meta = document.createElement("p");
    meta.className = "stats-session-meta";
    meta.textContent = [
      session.display_source || session.source_kind,
      session.cwd,
      formatListTimestamp(session.last_timestamp),
      session.workspace?.favorite ? t("favorite") : "",
      ...(session.workspace?.tags || []),
    ]
      .filter(Boolean)
      .join(" · ");
    const metrics = document.createElement("dl");
    metrics.className = "stats-session-metrics";
    for (const [label, value, format] of [
      ["statsTokenShort", session.tokens, formatCount],
      ["statsMessages", session.message_count, formatCount],
      ["statsTools", session.tool_calls, formatCount],
      ["statsCostShort", session.cost, formatCost],
    ]) {
      const term = document.createElement("dt");
      term.textContent = t(label);
      const count = document.createElement("dd");
      count.textContent = value == null ? "—" : format(value);
      if (value == null) count.title = t("statsUsageUnknown");
      metrics.append(term, count);
    }
    item.append(open, meta, metrics);
    if (session.workspace?.note) {
      const note = document.createElement("p");
      note.className = "stats-session-note";
      note.textContent = session.workspace.note;
      item.append(note);
    }
    list.append(item);
  }
  container.append(list);
  if (loading) {
    const pending = document.createElement("p");
    pending.className = "stats-sessions-hint";
    pending.setAttribute("role", "status");
    pending.textContent = t("loading");
    container.append(pending);
  } else if (error) {
    const failure = document.createElement("p");
    failure.setAttribute("role", "alert");
    failure.textContent = `${t("statsSessionsFailed")} · ${error.message}`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "ghost-button";
    retry.textContent = t("retry");
    retry.addEventListener("click", onRetry);
    container.append(failure, retry);
  } else if (data && !data.sessions.length) {
    container.append(
      createEmptyState({ title: t("noResults"), compact: true })
    );
  }
  if (data) {
    const status = document.createElement("p");
    status.className = "stats-sessions-hint";
    status.setAttribute("role", "status");
    status.textContent = t("statsSessionsLoaded", {
      n: data.sessions.length,
      total: data.total,
    });
    container.append(status);
  }
  if (data?.has_more) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "ghost-button load-more-btn";
    more.textContent = t("loadMore");
    more.disabled = loading;
    more.addEventListener("click", onMore);
    container.append(more);
  }
}
