import { t } from "./i18n.js";
import { createEmptyState } from "./ui-components.js";
import {
  displaySessionTitle,
  formatCount,
  formatCost,
  formatListTimestamp,
} from "./session-format.js";

const views = new WeakMap();
function element(tag, className = "") {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
function createView(container) {
  const heading = element("div", "stats-sessions-heading");
  const title = element("h3");
  const select = element("select");
  const options = [
    ["recent", "searchRecent"],
    ["tokens", "statsSessionsMostTokens"],
    ["cost", "statsSessionsMostCost"],
  ].map(([value, key]) => {
    const option = element("option");
    option.value = value;
    select.append(option);
    return { option, key };
  });
  heading.append(title, select);
  const hint = element("p", "stats-sessions-hint");
  const list = element("ol", "stats-session-list");
  const status = element("p", "stats-sessions-hint");
  status.setAttribute("role", "status");
  const failure = element("p");
  failure.setAttribute("role", "alert");
  const retry = element("button", "ghost-button");
  const more = element("button", "ghost-button load-more-btn");
  const empty = createEmptyState({ title: t("noResults"), compact: true });
  retry.type = more.type = "button";
  retry.hidden = more.hidden = true;
  container.replaceChildren(
    heading,
    hint,
    list,
    status,
    failure,
    retry,
    more,
    empty
  );
  const view = {
    title,
    select,
    options,
    hint,
    list,
    status,
    failure,
    retry,
    more,
    empty,
    rows: new Map(),
  };
  select.addEventListener("change", () => view.callbacks.onSort(select.value));
  retry.addEventListener("click", () => {
    if (!view.loading) view.callbacks.onRetry();
  });
  more.addEventListener("click", () => {
    if (!view.loading) view.callbacks.onMore();
  });
  return view;
}
function createRow(view, key) {
  const item = element("li");
  const open = element("button", "stats-activity-link");
  open.type = "button";
  open.addEventListener("click", () => view.callbacks.onSelectSession(key));
  const meta = element("p", "stats-session-meta");
  const metrics = element("dl", "stats-session-metrics");
  const note = element("p", "stats-session-note");
  item.append(open, meta, metrics, note);
  return { item, open, meta, metrics, note };
}
export function renderStatsSessionList(
  container,
  { data, sort = "recent", loading = false, error },
  callbacks
) {
  if (!container) return;
  let view = views.get(container);
  if (!view || !container.contains(view.select)) {
    view = createView(container);
    views.set(container, view);
  }
  const focused = document.activeElement;
  const focusedInside = container.contains(focused);
  const previousKeys = new Set(view.rows.keys());
  view.callbacks = callbacks;
  view.loading = loading;
  container.setAttribute("aria-busy", String(loading));
  view.title.textContent = t("statsRelatedSessions");
  view.select.setAttribute("aria-label", t("statsSessionsSort"));
  view.select.value = sort;
  for (const { option, key } of view.options) option.textContent = t(key);
  view.hint.textContent = t("statsSessionsHint");

  // 保留已有的行和操作节点，分页只追加新行；排序或重查按键同步。
  const sessions = data?.sessions || [];
  const keys = new Set(sessions.map((session) => session._key));
  for (const [key, row] of view.rows) {
    if (!keys.has(key)) {
      row.item.remove();
      view.rows.delete(key);
    }
  }
  sessions.forEach((session, index) => {
    let row = view.rows.get(session._key);
    if (!row) {
      row = createRow(view, session._key);
      view.rows.set(session._key, row);
    }
    row.open.textContent = displaySessionTitle(session) || session._key;
    row.meta.textContent = [
      session.display_source || session.source_kind,
      session.cwd,
      formatListTimestamp(session.last_timestamp),
      session.workspace?.favorite ? t("favorite") : "",
      ...(session.workspace?.tags || []),
    ]
      .filter(Boolean)
      .join(" · ");
    row.metrics.replaceChildren();
    for (const [label, value, format] of [
      ["statsTokenShort", session.tokens, formatCount],
      ["statsMessages", session.message_count, formatCount],
      ["statsTools", session.tool_calls, formatCount],
      ["statsCostShort", session.cost, formatCost],
    ]) {
      const term = element("dt");
      term.textContent = t(label);
      const count = element("dd");
      count.textContent = value == null ? "—" : format(value);
      if (value == null) count.title = t("statsUsageUnknown");
      row.metrics.append(term, count);
    }
    row.note.textContent = session.workspace?.note || "";
    row.note.hidden = !row.note.textContent;
    if (view.list.children[index] !== row.item)
      view.list.insertBefore(row.item, view.list.children[index] || null);
  });
  view.status.textContent = loading
    ? t("loading")
    : data
      ? sessions.length
        ? t("statsSessionsLoaded", { n: sessions.length, total: data.total })
        : ""
      : "";
  view.empty.hidden = loading || Boolean(error) || !data || sessions.length > 0;
  view.empty.querySelector(".ui-empty-title").textContent = t("noResults");
  view.failure.textContent = error
    ? t("statsSessionsFailed") + " · " + error.message
    : "";
  view.failure.hidden = !error;
  view.retry.textContent = t("retry");
  view.more.textContent = t("loadMore");
  // aria-disabled 保留等待中的按钮焦点；事件处理器同步阻止重复提交。
  view.retry.hidden = !error && !(loading && !view.retry.hidden);
  view.more.hidden = !data?.has_more;
  for (const control of [view.retry, view.more])
    control.setAttribute("aria-disabled", String(loading));
  if (
    focusedInside &&
    ((focused === view.retry && view.retry.hidden) ||
      (focused === view.more && view.more.hidden) ||
      !container.contains(focused))
  ) {
    const added = sessions.find((session) => !previousKeys.has(session._key));
    const target = added ? view.rows.get(added._key)?.open : view.select;
    target?.focus({ preventScroll: true });
  }
}
