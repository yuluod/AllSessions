import { t } from "./i18n.js";
import { formatCount } from "./session-format.js";

const AGENT_PRESENTATION = {
  codex: { label: "Codex", color: "#0f766e" },
  claude: { label: "Claude Code", color: "#a15c07" },
  gemini: { label: "Gemini CLI", color: "#4f46e5" },
  pi: { label: "Pi", color: "#2563eb" },
  kimi: { label: "Kimi Code CLI", color: "#b42318" },
  opencode: { label: "OpenCode", color: "#16794f" },
  kilo: { label: "Kilo", color: "#c45038" },
  zcode: { label: "ZCode", color: "#3b6ea5" },
  cursor: { label: "Cursor", color: "#52525b" },
  devin: { label: "Devin", color: "#0891b2" },
  copilot: { label: "GitHub Copilot", color: "#6f42c1" },
  hermes: { label: "Hermes Agent", color: "#be185d" },
};

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

const TOKEN_UNIT_STEPS = [
  { limit: 1_000_000_000, suffix: "B" },
  { limit: 1_000_000, suffix: "M" },
  { limit: 1_000, suffix: "k" },
];

// 卡片与图表轴上的紧凑写法；完整千分位数值放在 title 里。
function formatTokensCompact(value) {
  const count = Number(value || 0);
  for (const { limit, suffix } of TOKEN_UNIT_STEPS) {
    if (count >= limit) {
      const scaled = count / limit;
      const digits = scaled >= 100 ? 0 : 1;
      return `${scaled.toFixed(digits).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return String(count);
}

function renderMetrics(stats, container) {
  container.replaceChildren();
  const byDate = stats.by_date || [];
  const total =
    stats.total ?? byDate.reduce((sum, item) => sum + (item.count || 0), 0);
  const activeDays = stats.active_days ?? byDate.length;
  const average =
    stats.avg_daily ?? (activeDays > 0 ? (total / activeDays).toFixed(1) : "0");
  const totalTokens = Number(stats.total_tokens || 0);
  const cards = [
    { label: t("statsTotalSessions"), value: String(total) },
    { label: t("statsMessages"), value: formatCount(stats.total_messages) },
    { label: t("statsTools"), value: formatCount(stats.total_tools) },
    {
      label: t("statsTokenTotal"),
      value: formatTokensCompact(totalTokens),
      title: `${formatCount(totalTokens)} (${t("statsTokenInput")} ${formatCount(stats.total_input_tokens)} · ${t("statsTokenOutput")} ${formatCount(stats.total_output_tokens)} · ${t("statsTokenCached")} ${formatCount(stats.total_cached_input_tokens)})`,
    },
    { label: t("statsEvents"), value: formatCount(stats.total_events) },
    { label: t("statsActiveDays"), value: String(activeDays) },
    { label: t("statsAvgDaily"), value: String(average) },
  ];
  cards.forEach(({ label, value, title }, index) => {
    const card = document.createElement("div");
    card.className = "metric-card";
    card.dataset.metricIdx = String(index);
    const valueElement = document.createElement("div");
    valueElement.className = "metric-value";
    valueElement.textContent = value;
    if (title) valueElement.title = title;
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
  const plot = document.createElement("div");
  plot.className = "trend-plot";
  const guides = document.createElement("div");
  guides.className = "trend-guides";
  guides.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 4; index += 1) {
    guides.append(document.createElement("span"));
  }
  const wrap = document.createElement("div");
  wrap.className = "trend-bars";
  dates.forEach(({ label, count, tokens }) => {
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
    const tokenText = tokens
      ? ` · ${t("statsTokenShort")} ${formatTokensCompact(tokens)}`
      : "";
    bar.title = `${label}: ${count}${tokenText}`;
    barWrap.append(bar);
    const date = document.createElement("span");
    date.className = "trend-date";
    date.textContent = label.length > 5 ? label.slice(5) : label;
    column.append(value, barWrap, date);
    wrap.append(column);
  });
  plot.append(guides, wrap);
  container.append(plot);
}

// GitHub 风格的日历热力图：最近 15 周，颜色深浅表示当日 token 用量。
const HEATMAP_WEEKS = 15;
const HEATMAP_LEVELS = 4;

// 用量分布通常右偏（个别重度日远超均值），线性分档会让绝大多数
// 日期挤在最低档；按平方根缩放后再分档，长尾日期也能落进中高档。
function heatmapLevel(tokens, max) {
  if (!tokens || max <= 0) return 0;
  const ratio = Math.sqrt(tokens / max);
  return Math.min(HEATMAP_LEVELS, 1 + Math.floor(ratio * HEATMAP_LEVELS));
}

function renderHeatmap(stats, container) {
  container.replaceChildren();
  const days = stats.by_date || [];
  if (!days.length) {
    renderEmpty(container);
    return;
  }
  const recent = days.slice(-HEATMAP_WEEKS * 7);
  const max = Math.max(...recent.map((day) => day.tokens || 0), 1);

  const wrap = document.createElement("div");
  wrap.className = "token-heatmap";

  const grid = document.createElement("div");
  grid.className = "token-heatmap-grid";
  grid.setAttribute("role", "img");
  grid.setAttribute(
    "aria-label",
    `${t("statsTokenHeatmap")}: ${formatCount(
      recent.reduce((sum, day) => sum + (day.tokens || 0), 0)
    )}`
  );
  // 第一天前面按星期补空格，让列对齐真实的周内位置（周一起始）。
  const firstDay = recent[0];
  const leading = (new Date(`${firstDay.label}T00:00:00`).getDay() + 6) % 7;
  for (let index = 0; index < leading; index += 1) {
    const pad = document.createElement("span");
    pad.className = "token-heatmap-cell is-empty";
    grid.append(pad);
  }
  recent.forEach((day) => {
    const cell = document.createElement("span");
    cell.className = "token-heatmap-cell";
    cell.dataset.level = String(heatmapLevel(day.tokens, max));
    cell.dataset.date = day.label;
    cell.dataset.tokens = String(day.tokens || 0);
    cell.dataset.count = String(day.count || 0);
    grid.append(cell);
  });
  wrap.append(grid);

  const footer = document.createElement("div");
  footer.className = "token-heatmap-footer";
  const range = document.createElement("span");
  range.className = "token-heatmap-range";
  range.textContent = `${recent[0].label} ~ ${recent[recent.length - 1].label}`;
  const legend = document.createElement("span");
  legend.className = "token-heatmap-legend";
  const less = document.createElement("span");
  less.textContent = t("statsHeatmapLess");
  legend.append(less);
  for (let level = 0; level <= HEATMAP_LEVELS; level += 1) {
    const swatch = document.createElement("span");
    swatch.className = "token-heatmap-cell";
    swatch.dataset.level = String(level);
    legend.append(swatch);
  }
  const more = document.createElement("span");
  more.textContent = t("statsHeatmapMore");
  legend.append(more);
  footer.append(range, legend);
  wrap.append(footer);
  attachHeatmapTooltip(grid);
  container.append(wrap);
}

// 原生 title 提示有约一秒延迟且样式不可控,改用自绘浮层:
// 悬停日期格立即显示当日的 token 用量与会话数,移开或滚动时消失。
function attachHeatmapTooltip(grid) {
  let tooltip = null;
  const hide = () => {
    tooltip?.remove();
    tooltip = null;
  };
  const show = (cell) => {
    tooltip = document.createElement("div");
    tooltip.className = "token-heatmap-tooltip";
    const date = document.createElement("strong");
    date.textContent = cell.dataset.date;
    const tokens = document.createElement("span");
    // 默认显示紧凑量级（如 523.8M），被缩写时附上弱化的精确值。
    const value = Number(cell.dataset.tokens || 0);
    const compact = formatTokensCompact(value);
    tokens.textContent = `${t("statsTokenShort")} ${compact}`;
    if (compact !== String(value)) {
      const exact = document.createElement("span");
      exact.className = "token-heatmap-tooltip-exact";
      exact.textContent = formatCount(value);
      tokens.append(" ", exact);
    }
    const count = document.createElement("span");
    count.textContent = `${t("statsSessionsShort")} ${cell.dataset.count}`;
    tooltip.append(date, tokens, count);
    document.body.append(tooltip);
    const cellRect = cell.getBoundingClientRect();
    const size = tooltip.getBoundingClientRect();
    // 优先显示在格子上方,顶部放不下时翻到下方;左右夹在窗口内。
    let left = cellRect.left + cellRect.width / 2 - size.width / 2;
    left = Math.min(Math.max(8, left), window.innerWidth - size.width - 8);
    const top =
      cellRect.top - size.height - 6 >= 8
        ? cellRect.top - size.height - 6
        : cellRect.bottom + 6;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };
  grid.addEventListener("mouseover", (event) => {
    const cell = event.target.closest(".token-heatmap-cell[data-date]");
    hide();
    if (cell) show(cell);
  });
  grid.addEventListener("mouseleave", hide);
  grid.addEventListener("scroll", hide, { passive: true });
}

// 按 Agent 分布的度量可在会话数与 Token 用量之间切换,跨渲染保留选择。
let agentMetric = "sessions";

function renderAgents(stats, container) {
  container.replaceChildren();
  const metricSource =
    agentMetric === "tokens" ? stats.by_agent_tokens : stats.by_agent;
  const items = (metricSource || []).slice(0, 7);
  if (!items.length) {
    renderEmpty(container);
    return;
  }
  const formatMetric = (value) =>
    agentMetric === "tokens" ? formatTokensCompact(value) : formatCount(value);
  const metricLabel =
    agentMetric === "tokens" ? t("statsTokenShort") : t("statsMetricSessions");

  const toggle = document.createElement("div");
  toggle.className = "agent-metric-toggle";
  for (const [value, label] of [
    ["sessions", t("statsMetricSessions")],
    ["tokens", t("statsTokenShort")],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-metric-option";
    button.dataset.metric = value;
    button.textContent = label;
    button.setAttribute("aria-pressed", String(agentMetric === value));
    button.addEventListener("click", () => {
      if (agentMetric === value) return;
      agentMetric = value;
      renderAgents(stats, container);
    });
    toggle.append(button);
  }
  container.append(toggle);

  const presentations = items.map(
    (item) =>
      AGENT_PRESENTATION[item.label] || {
        label: item.label,
        color: "#59656d",
      }
  );
  const total = items.reduce((sum, item) => sum + item.count, 0);
  let accumulated = 0;
  const stops = items.map((item, index) => {
    const percent = (item.count / total) * 100;
    const start = accumulated;
    accumulated += percent;
    return `${presentations[index].color} ${start.toFixed(2)}% ${accumulated.toFixed(2)}%`;
  });
  const wrap = document.createElement("div");
  wrap.className = "donut-wrap";
  const visual = document.createElement("div");
  visual.className = "donut-visual";
  visual.setAttribute("role", "img");
  visual.setAttribute(
    "aria-label",
    `${t("statsAgentDist")} · ${metricLabel}: ${formatMetric(total)}`
  );
  const donut = document.createElement("div");
  donut.className = "donut-chart";
  donut.setAttribute("aria-hidden", "true");
  donut.style.background = `conic-gradient(${stops.join(", ")})`;
  donut.style.mask = "radial-gradient(transparent 55%, black 56%)";
  donut.style.webkitMask = "radial-gradient(transparent 55%, black 56%)";
  const donutCenter = document.createElement("div");
  donutCenter.className = "donut-center";
  const donutTotal = document.createElement("strong");
  donutTotal.textContent = formatMetric(total);
  donutTotal.title = agentMetric === "tokens" ? formatCount(total) : "";
  const donutLabel = document.createElement("span");
  donutLabel.textContent = metricLabel;
  donutCenter.append(donutTotal, donutLabel);
  visual.append(donut, donutCenter);
  const legend = document.createElement("div");
  legend.className = "donut-legend";
  items.forEach((item, index) => {
    const presentation = presentations[index];
    const row = document.createElement("div");
    row.className = "donut-legend-item";
    const dot = document.createElement("span");
    dot.className = "donut-dot";
    dot.style.background = presentation.color;
    const name = document.createElement("span");
    name.textContent = presentation.label;
    const count = document.createElement("span");
    count.textContent = formatMetric(item.count);
    count.title = agentMetric === "tokens" ? formatCount(item.count) : "";
    count.style.textAlign = "right";
    const percent = document.createElement("span");
    percent.className = "donut-pct";
    percent.textContent = `${((item.count / total) * 100).toFixed(1)}%`;
    row.append(dot, name, count, percent);
    legend.append(row);
  });
  wrap.append(visual, legend);
  container.append(wrap);
}

function renderRankings(stats, container) {
  container.replaceChildren();
  const sections = [
    {
      title: t("statsRecentDaily"),
      items: (stats.by_date || []).slice(-14),
      kind: "daily",
    },
    {
      title: t("statsCommonProvider"),
      items: stats.by_provider || [],
      kind: "provider",
    },
    {
      title: t("statsCommonCwd"),
      items: (stats.by_cwd || []).slice(0, 8),
      isPath: true,
      kind: "cwd",
    },
  ];
  sections.forEach(({ title, items, isPath, kind }) => {
    if (!items.length) return;
    const section = document.createElement("div");
    section.className = `stats-section stats-section--${kind}`;
    const heading = document.createElement("h3");
    heading.textContent = title;
    const body = document.createElement("div");
    body.className = "stats-section__body";
    const max = Math.max(...items.map((item) => item.count), 1);
    items.forEach(({ label, count }) => {
      const displayLabel = isPath ? label.split(/[\\/]/).pop() || label : label;
      body.append(renderBar(label, count, max, displayLabel));
    });
    section.append(heading, body);
    container.append(section);
  });
}

export function renderStats(stats, elements) {
  if (!elements.statsDashboard) return;
  if (elements.statsMetrics) renderMetrics(stats, elements.statsMetrics);
  if (elements.trendChartBody) renderTrend(stats, elements.trendChartBody);
  if (elements.agentChartBody) renderAgents(stats, elements.agentChartBody);
  if (elements.tokenHeatmapBody) {
    renderHeatmap(stats, elements.tokenHeatmapBody);
  }
  if (elements.statsGrid) renderRankings(stats, elements.statsGrid);
}
