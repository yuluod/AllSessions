import { t } from "./i18n.js";
import {
  displaySessionTitle,
  formatCount,
  formatListTimestamp,
} from "./session-format.js";
import { collectFileEdits, renderHunk } from "./diff-view.js";

export function fileActivity(groups) {
  const files = new Map();
  for (const { message } of groups) {
    for (const activity of message.file_activity || []) {
      const key = `${activity.action}\n${activity.path}`;
      if (!files.has(key))
        files.set(key, { ...activity, count: 0, index: message._origIdx });
      files.get(key).count += 1;
    }
  }
  return [...files.values()].sort(
    (a, b) => b.count - a.count || a.path.localeCompare(b.path)
  );
}

export function modelUsage(usage) {
  return Object.entries(usage?.by_model || {})
    .map(([name, entry]) => ({
      name,
      tokens: ["input", "output", "cache_read", "cache_write"].reduce(
        (sum, key) => sum + Number(entry?.totals?.[key] || 0),
        0
      ),
    }))
    .filter((model) => model.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
}

export function renderSessionInsights(
  detail,
  groups,
  container,
  { onSelectMessage, onSelectSession } = {}
) {
  if (!container) return;
  container.replaceChildren();
  const files = fileActivity(groups);
  const changes = collectFileEdits(groups);
  const family = detail?.related_sessions?.items || [];
  const events = detail?.usage_events || [];
  container.classList.toggle(
    "hidden",
    !files.length && !changes.length && !family.length && !events.length
  );
  if (!files.length && !changes.length && !family.length && !events.length)
    return;
  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.textContent = t("sessionInsights");
  summary.append(title);
  const metrics = [];
  if (files.length) metrics.push(t("insightsMetricFiles", { n: files.length }));
  if (changes.length) {
    let added = 0;
    let removed = 0;
    for (const file of changes) {
      added += file.added;
      removed += file.removed;
    }
    metrics.push(`+${formatCount(added)} −${formatCount(removed)}`);
  }
  if (family.length)
    metrics.push(
      t("insightsMetricFamily", {
        n: detail?.related_sessions?.total || family.length,
      })
    );
  if (events.length) {
    const tokens = events.reduce(
      (sum, event) =>
        sum +
        ["input", "output", "cache_read", "cache_write"].reduce(
          (acc, key) => acc + Number(event.usage[key] || 0),
          0
        ),
      0
    );
    if (tokens) metrics.push(`${formatCount(tokens)} tokens`);
  }
  if (metrics.length) {
    const badge = document.createElement("span");
    badge.className = "session-insights-metrics";
    badge.textContent = metrics.join(" · ");
    summary.append(badge);
  }
  container.append(summary);

  if (files.length) {
    const heading = document.createElement("h4");
    heading.textContent = t("sessionFiles");
    const scope = document.createElement("p");
    scope.className = "tool-operations-scope";
    scope.textContent = t("sessionFilesScope", {
      n: Math.min(files.length, 64),
      total: files.length,
    });
    const list = document.createElement("ul");
    list.className = "tool-operations-list";
    for (const file of files.slice(0, 64)) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost-button tool-operation-link";
      button.textContent = `${t(`fileActivity_${file.action}`)} · ${file.path} · ${file.count}`;
      button.addEventListener("click", () => onSelectMessage?.(file.index));
      item.append(button);
      list.append(item);
    }
    container.append(heading, scope, list);
  }

  if (changes.length) {
    const heading = document.createElement("h4");
    heading.textContent = t("sessionFileChanges");
    const scope = document.createElement("p");
    scope.className = "tool-operations-scope";
    scope.textContent = t("sessionFileChangesScope", {
      n: Math.min(changes.length, 64),
      total: changes.length,
    });
    const list = document.createElement("div");
    list.className = "file-changes-list";
    for (const file of changes.slice(0, 64)) {
      const detail = document.createElement("details");
      detail.className = "file-change";
      const summary = document.createElement("summary");
      const path = document.createElement("span");
      path.className = "file-change-path";
      path.textContent = file.path;
      path.title = file.path;
      const counts = document.createElement("span");
      counts.className = "diff-counts";
      const add = document.createElement("span");
      add.className = "diff-count-add";
      add.textContent = `+${file.added}`;
      const del = document.createElement("span");
      del.className = "diff-count-del";
      del.textContent = `−${file.removed}`;
      counts.append(add, del);
      summary.append(path, counts);
      detail.append(summary);
      // diff 在首次展开时才计算：多文件会话可避免一次性跑全部 LCS。
      detail.addEventListener(
        "toggle",
        () => {
          if (!detail.open || detail.dataset.rendered) return;
          detail.dataset.rendered = "1";
          for (const { index, hunk } of file.edits) {
            const link = document.createElement("button");
            link.type = "button";
            link.className = "ghost-button tool-operation-link";
            link.textContent = `#${index + 1}`;
            link.addEventListener("click", () => onSelectMessage?.(index));
            const host = document.createElement("div");
            host.className = "file-change-hunk";
            host.append(link);
            detail.append(host, renderHunk(hunk));
          }
        },
        { passive: true }
      );
      list.append(detail);
    }
    container.append(heading, scope, list);
  }

  if (family.length) {
    const heading = document.createElement("h4");
    heading.textContent = t("sessionFamily");
    const scope = document.createElement("p");
    scope.className = "tool-operations-scope";
    scope.textContent = t("sessionFamilyScope", {
      n: family.length,
      total: detail.related_sessions.total,
    });
    container.append(heading, scope);
    for (const session of family) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost-button tool-operation-link";
      button.textContent = `${t(`sessionRelation_${session.relation}`)} · ${displaySessionTitle(session) || session.key}`;
      button.addEventListener("click", () => onSelectSession?.(session.key));
      container.append(button);
    }
  }

  if (events.length) {
    const heading = document.createElement("h4");
    heading.textContent = t("sessionUsageEvents");
    const scope = document.createElement("p");
    scope.className = "tool-operations-scope";
    scope.textContent = t("sessionUsageEventsScope", {
      n: Math.min(events.length, 30),
      total: detail.usage_event_count || events.length,
    });
    const trend = document.createElement("div");
    trend.className = "session-usage-trend";
    trend.setAttribute("aria-hidden", "true");
    const recent = events.slice(-30);
    const totals = recent.map((event) =>
      ["input", "output", "cache_read", "cache_write"].reduce(
        (sum, key) => sum + Number(event.usage[key] || 0),
        0
      )
    );
    const maximum = Math.max(...totals, 1);
    recent.forEach((event, index) => {
      const bar = document.createElement("span");
      bar.style.height = `${Math.max(1, (totals[index] / maximum) * 100)}%`;
      bar.title = `${event.timestamp} · ${formatCount(totals[index])} Token`;
      trend.append(bar);
    });
    const scroll = document.createElement("div");
    scroll.className = "session-usage-scroll";
    const table = document.createElement("table");
    table.className = "session-usage-table";
    const caption = document.createElement("caption");
    caption.textContent = t("sessionUsageEvents");
    caption.className = "visually-hidden";
    table.append(caption);
    const head = document.createElement("thead");
    const header = document.createElement("tr");
    for (const label of [
      "date",
      "statsTokenInput",
      "statsTokenOutput",
      "statsCacheRead",
      "statsCacheWrite",
    ]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = t(label);
      header.append(cell);
    }
    head.append(header);
    const body = document.createElement("tbody");
    for (const event of events.slice(-30)) {
      const row = document.createElement("tr");
      for (const value of [
        formatListTimestamp(event.timestamp),
        ...["input", "output", "cache_read", "cache_write"].map((key) =>
          formatCount(event.usage[key])
        ),
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        cell.title = event.timestamp;
        row.append(cell);
      }
      body.append(row);
    }
    table.append(head, body);
    scroll.append(table);
    container.append(heading, scope, trend, scroll);
  }
}
