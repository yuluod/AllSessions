import { t } from "./i18n.js";
import { formatCount } from "./session-format.js";

function renderBar(label, count, max, displayLabel = label) {
  const row = document.createElement("div");
  row.className = "stats-bar-row";
  const percent = max > 0 ? Math.round((count / max) * 100) : 0;
  const labelElement = document.createElement("span");
  labelElement.className = "stats-bar-label";
  labelElement.title = label;
  labelElement.textContent = displayLabel;
  const track = document.createElement("div");
  track.className = "stats-bar-track";
  const fill = document.createElement("div");
  fill.className = "stats-bar-fill";
  fill.style.width = `${percent}%`;
  track.append(fill);
  const countElement = document.createElement("span");
  countElement.className = "stats-bar-count";
  countElement.textContent = String(count);
  row.append(labelElement, track, countElement);
  return row;
}

function renderEmpty(container) {
  const empty = document.createElement("div");
  empty.className = "stats-empty";
  empty.textContent = "—";
  container.append(empty);
}

function renderMetrics(stats, container) {
  container.replaceChildren();
  const byDate = stats.by_date || [];
  const total = stats.total ?? byDate.reduce((sum, item) => sum + (item.count || 0), 0);
  const activeDays = stats.active_days ?? byDate.length;
  const average = stats.avg_daily ?? (activeDays > 0 ? (total / activeDays).toFixed(1) : "0");
  const cards = [
    { label: t("statsTotalSessions"), value: String(total) },
    { label: t("statsActiveDays"), value: String(activeDays) },
    { label: t("statsAvgDaily"), value: String(average) },
    { label: t("statsEvents"), value: formatCount(stats.total_events) }
  ];
  cards.forEach(({ label, value }, index) => {
    const card = document.createElement("div");
    card.className = "metric-card";
    card.dataset.metricIdx = String(index);
    const valueElement = document.createElement("div");
    valueElement.className = "metric-value";
    valueElement.textContent = value;
    const labelElement = document.createElement("div");
    labelElement.className = "metric-label";
    labelElement.textContent = label;
    const spark = document.createElement("div");
    spark.className = "metric-spark";
    const sparkInner = document.createElement("div");
    sparkInner.className = "metric-spark-bar";
    sparkInner.style.width = byDate.length
      ? `${Math.min(100, (byDate.reduce((sum, item) => sum + item.count, 0) / (byDate.length * 10)) * 100)}%`
      : "0%";
    spark.append(sparkInner);
    card.append(valueElement, labelElement, spark);
    container.append(card);
  });
}

function renderTrend(stats, container) {
  container.replaceChildren();
  const dates = (stats.by_date || []).slice(-14);
  if (!dates.length) {
    renderEmpty(container);
    return;
  }
  const max = Math.max(...dates.map((item) => item.count), 1);
  const wrap = document.createElement("div");
  wrap.className = "trend-bars";
  dates.forEach(({ label, count }) => {
    const column = document.createElement("div");
    column.className = "trend-col";
    const value = document.createElement("span");
    value.className = "trend-val";
    value.textContent = String(count);
    const barWrap = document.createElement("div");
    barWrap.className = "trend-bar-wrap";
    const bar = document.createElement("div");
    bar.className = "trend-bar";
    bar.style.height = `${(count / max) * 100}%`;
    bar.title = `${label}: ${count}`;
    barWrap.append(bar);
    const date = document.createElement("span");
    date.className = "trend-date";
    date.textContent = label.length > 5 ? label.slice(5) : label;
    column.append(value, barWrap, date);
    wrap.append(column);
  });
  container.append(wrap);
}

function renderProviders(stats, container) {
  container.replaceChildren();
  const items = (stats.by_provider || []).slice(0, 6);
  if (!items.length) {
    renderEmpty(container);
    return;
  }
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const colors = ["#0f766e", "#2563eb", "#a15c07", "#b42318", "#16794f", "#7c3aed"];
  let accumulated = 0;
  const stops = items.map((item, index) => {
    const percent = (item.count / total) * 100;
    const start = accumulated;
    accumulated += percent;
    return `${colors[index % colors.length]} ${start.toFixed(2)}% ${accumulated.toFixed(2)}%`;
  });
  const wrap = document.createElement("div");
  wrap.className = "donut-wrap";
  const donut = document.createElement("div");
  donut.className = "donut-chart";
  donut.style.background = `conic-gradient(${stops.join(", ")})`;
  donut.style.mask = "radial-gradient(transparent 55%, black 56%)";
  donut.style.webkitMask = "radial-gradient(transparent 55%, black 56%)";
  const legend = document.createElement("div");
  legend.className = "donut-legend";
  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "donut-legend-item";
    const dot = document.createElement("span");
    dot.className = "donut-dot";
    dot.style.background = colors[index % colors.length];
    const name = document.createElement("span");
    name.textContent = item.label;
    const count = document.createElement("span");
    count.textContent = String(item.count);
    count.style.textAlign = "right";
    const percent = document.createElement("span");
    percent.className = "donut-pct";
    percent.textContent = `${((item.count / total) * 100).toFixed(1)}%`;
    row.append(dot, name, count, percent);
    legend.append(row);
  });
  wrap.append(donut, legend);
  container.append(wrap);
}

function renderRankings(stats, container) {
  container.replaceChildren();
  const sections = [
    { title: t("statsRecentDaily"), items: (stats.by_date || []).slice(-14) },
    { title: t("statsCommonSourceKind"), items: stats.by_source_kind || [] },
    { title: t("statsCommonProvider"), items: stats.by_provider || [] },
    { title: t("statsCommonCwd"), items: (stats.by_cwd || []).slice(0, 8), isPath: true }
  ];
  sections.forEach(({ title, items, isPath }) => {
    if (!items.length) return;
    const section = document.createElement("div");
    section.className = "stats-section";
    const heading = document.createElement("h3");
    heading.textContent = title;
    section.append(heading);
    const max = Math.max(...items.map((item) => item.count), 1);
    items.forEach(({ label, count }) => {
      const displayLabel = isPath ? label.split(/[\\/]/).pop() || label : label;
      section.append(renderBar(label, count, max, displayLabel));
    });
    container.append(section);
  });
}

export function renderStats(stats, elements) {
  if (!elements.statsDashboard) return;
  if (elements.statsMetrics) renderMetrics(stats, elements.statsMetrics);
  if (elements.trendChartBody) renderTrend(stats, elements.trendChartBody);
  if (elements.donutChartBody) renderProviders(stats, elements.donutChartBody);
  if (elements.statsGrid) renderRankings(stats, elements.statsGrid);
}
