import { t, getLang } from "./i18n.js";
import { formatCount } from "./session-format.js";
import { calendarHeatmapDays, presetHeatmapRange } from "./stats-calendar.js";
import { createEmptyState } from "./ui-components.js";

const AGENT_PRESENTATION = {
  codex: { label: "Codex", color: "#0f766e" },
  claude: { label: "Claude Code", color: "#a15c07" },
  gemini: { label: "Gemini CLI", color: "#4f46e5" },
  grok: { label: "Grok Build", color: "#52525b" },
  pi: { label: "Pi", color: "#2563eb" },
  kimi: { label: "Kimi Code CLI", color: "#b42318" },
  opencode: { label: "OpenCode", color: "#16794f" },
  kilo: { label: "Kilo", color: "#c45038" },
  zcode: { label: "ZCode", color: "#3b6ea5" },
  cursor: { label: "Cursor", color: "#52525b" },
  devin: { label: "Devin", color: "#0891b2" },
  copilot: { label: "GitHub Copilot", color: "#6f42c1" },
  hermes: { label: "Hermes Agent", color: "#be185d" },
  deepseek: { label: "DeepSeek", color: "#4d6bfe" },
};

function renderBar(label, count, max, displayLabel = label, tokens = null) {
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
  if (tokens !== null) {
    const tokenElement = document.createElement("span");
    tokenElement.className = "stats-bar-tokens";
    tokenElement.textContent = tokens > 0 ? formatTokensCompact(tokens) : "—";
    if (tokens > 0) {
      tokenElement.title = `${t("statsTokenShort")} ${formatCount(tokens)}`;
    }
    row.append(tokenElement);
  }
  return row;
}

function renderEmpty(container) {
  const empty = createEmptyState({
    title: t("statsNoData"),
    description: t("statsNoDataHint"),
    compact: true,
  });
  empty.classList.add("stats-empty");
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
    card.append(valueElement, labelElement);
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

// 按本机日历选择常用范围，也可指定起止日期，仅调整热力图。
let heatmapPreset = "month";
let heatmapRange = null;
const HEATMAP_LEVELS = 4;

// 用量分布通常右偏（个别重度日远超均值），线性分档会让绝大多数
// 日期挤在最低档；按平方根缩放后再分档，长尾日期也能落进中高档。
function heatmapLevel(tokens, max) {
  if (!tokens || max <= 0) return 0;
  const ratio = Math.sqrt(tokens / max);
  return Math.min(HEATMAP_LEVELS, 1 + Math.floor(ratio * HEATMAP_LEVELS));
}

const MONTH_LABELS_EN = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function monthLabel(key) {
  const month = Number(key.slice(5, 7));
  return getLang() === "zh" ? `${month}月` : MONTH_LABELS_EN[month - 1];
}

// 与后端 local_date_key 同口径的本机日期键，用于标记“今天”。
function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderHeatmap(stats, container) {
  container.replaceChildren();
  const days = stats.by_date || [];
  if (!days.length) {
    renderEmpty(container);
    return;
  }
  const selectedRange = heatmapRange || presetHeatmapRange(days, heatmapPreset);
  const recent = calendarHeatmapDays(days, selectedRange);
  const max = Math.max(...recent.map((day) => day.tokens || 0), 1);

  const wrap = document.createElement("div");
  wrap.className = "token-heatmap";
  const presets = document.createElement("div");
  presets.className = "token-heatmap-presets";
  presets.setAttribute("role", "group");
  presets.setAttribute("aria-label", t("statsHeatmapRange"));
  for (const [value, key] of [
    ["week", "statsHeatmapWeek"],
    ["month", "statsHeatmapMonth"],
    ["30days", "statsHeatmap30Days"],
    ["all", "statsHeatmapAll"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost-button";
    button.dataset.range = value;
    button.textContent = t(key);
    button.setAttribute(
      "aria-pressed",
      String(!heatmapRange && heatmapPreset === value)
    );
    button.addEventListener("click", () => {
      heatmapPreset = value;
      heatmapRange = null;
      renderHeatmap(stats, container);
      container.querySelector(`[data-range="${value}"]`)?.focus();
    });
    presets.append(button);
  }
  wrap.append(presets);

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
  const leading = (new Date(`${firstDay.label}T00:00:00Z`).getUTCDay() + 6) % 7;
  const weeks = Math.ceil((leading + recent.length) / 7);
  const columns = `repeat(${weeks}, 13px)`;
  grid.style.gridTemplateColumns = columns;

  // 月份标签占该月首末日所在的首末周列；后一个月的起点不早于上一个
  // 已显示标签的末列，跨度不足两列（放不下文字）时整条跳过。
  const monthSpans = [];
  let currentKey = "";
  let monthStart = 0;
  let monthEnd = 0;
  recent.forEach((day, index) => {
    const column = Math.floor((leading + index) / 7);
    const key = day.label.slice(0, 7);
    if (key !== currentKey) {
      if (currentKey) {
        monthSpans.push({ key: currentKey, start: monthStart, end: monthEnd });
      }
      currentKey = key;
      monthStart = column;
    }
    monthEnd = column;
  });
  if (currentKey) {
    monthSpans.push({ key: currentKey, start: monthStart, end: monthEnd });
  }

  const area = document.createElement("div");
  area.className = "token-heatmap-area";
  const weekdays = document.createElement("div");
  weekdays.className = "token-heatmap-weekdays";
  weekdays.setAttribute("aria-hidden", "true");
  for (const [row, key] of [
    [0, "statsWeekdayMon"],
    [2, "statsWeekdayWed"],
    [4, "statsWeekdayFri"],
  ]) {
    const label = document.createElement("span");
    label.style.gridRow = String(row + 1);
    label.textContent = t(key);
    weekdays.append(label);
  }
  const scroll = document.createElement("div");
  scroll.className = "token-heatmap-scroll";
  const months = document.createElement("div");
  months.className = "token-heatmap-months";
  months.setAttribute("aria-hidden", "true");
  months.style.gridTemplateColumns = columns;
  let labelEnd = -1;
  for (const span of monthSpans) {
    const start = Math.max(span.start, labelEnd + 1);
    if (span.end - start < 1) continue;
    labelEnd = span.end;
    const label = document.createElement("span");
    label.style.gridColumn = `${start + 1} / span ${span.end - start + 1}`;
    label.textContent = monthLabel(span.key);
    months.append(label);
  }
  for (let index = 0; index < leading; index += 1) {
    const pad = document.createElement("span");
    pad.className = "token-heatmap-cell is-empty";
    grid.append(pad);
  }
  const todayKey = localDateKey(new Date());
  recent.forEach((day) => {
    const cell = document.createElement("span");
    cell.className = "token-heatmap-cell";
    if (day.label === todayKey) cell.classList.add("is-today");
    cell.dataset.level = String(heatmapLevel(day.tokens, max));
    cell.dataset.date = day.label;
    cell.dataset.tokens = String(day.tokens || 0);
    cell.dataset.count = String(day.count || 0);
    grid.append(cell);
  });
  scroll.append(months, grid);
  area.append(weekdays, scroll);
  wrap.append(area);

  const footer = document.createElement("div");
  footer.className = "token-heatmap-footer";
  const range = document.createElement("form");
  range.className = "token-heatmap-range";
  range.setAttribute("aria-label", t("statsHeatmapRange"));
  const inputs = {};
  for (const [key, labelText] of [
    ["start", t("statsHeatmapStart")],
    ["end", t("statsHeatmapEnd")],
  ]) {
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "date";
    input.required = true;
    input.value = selectedRange[key];
    input.name = key;
    input.addEventListener("input", () => inputs.end.setCustomValidity(""));
    inputs[key] = input;
    label.append(input);
    range.append(label);
  }
  const apply = document.createElement("button");
  apply.type = "submit";
  apply.className = "ghost-button";
  apply.textContent = t("statsHeatmapApply");
  range.append(apply);
  range.addEventListener("submit", (event) => {
    event.preventDefault();
    if (inputs.start.value > inputs.end.value) {
      inputs.end.setCustomValidity(t("statsHeatmapInvalidRange"));
      inputs.end.reportValidity();
      return;
    }
    heatmapRange = { start: inputs.start.value, end: inputs.end.value };
    renderHeatmap(stats, container);
  });
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

// 双环同屏:左环按会话数占比,右环按 Token 用量占比;图例合并两列数值。
const AGENT_SLICE_LIMIT = 7;
const OTHER_AGENT = "__other__";

function donutVisual(stops, ariaLabel, centerText, centerLabel, centerTitle) {
  const visual = document.createElement("div");
  visual.className = "donut-visual";
  visual.setAttribute("role", "img");
  visual.setAttribute("aria-label", ariaLabel);
  const donut = document.createElement("div");
  donut.className = "donut-chart";
  donut.setAttribute("aria-hidden", "true");
  if (stops.length) {
    donut.style.background = `conic-gradient(${stops.join(", ")})`;
  }
  donut.style.mask = "radial-gradient(transparent 55%, black 56%)";
  donut.style.webkitMask = "radial-gradient(transparent 55%, black 56%)";
  const donutCenter = document.createElement("div");
  donutCenter.className = "donut-center";
  const donutTotal = document.createElement("strong");
  donutTotal.textContent = centerText;
  if (centerTitle) donutTotal.title = centerTitle;
  const donutLabel = document.createElement("span");
  donutLabel.textContent = centerLabel;
  donutCenter.append(donutTotal, donutLabel);
  visual.append(donut, donutCenter);
  return visual;
}

function renderAgents(stats, container) {
  container.replaceChildren();
  const sessions = stats.by_agent || [];
  const tokens = stats.by_agent_tokens || [];
  const top = sessions.slice(0, AGENT_SLICE_LIMIT);
  const restCount = sessions
    .slice(AGENT_SLICE_LIMIT)
    .reduce((sum, item) => sum + (item.count || 0), 0);
  // 「其他」兜底剩余来源,两环扇区、图例与中心数字始终同口径(全量合计)。
  const items =
    restCount > 0 ? [...top, { label: OTHER_AGENT, count: restCount }] : top;
  if (!items.length) {
    renderEmpty(container);
    return;
  }
  const tokenByAgent = new Map(
    tokens.map((item) => [item.label, item.count || 0])
  );
  const tokenTotal = tokens.reduce((sum, item) => sum + (item.count || 0), 0);
  const topTokenSum = top.reduce(
    (sum, item) => sum + (tokenByAgent.get(item.label) || 0),
    0
  );
  const tokensOf = (item) =>
    item.label === OTHER_AGENT
      ? Math.max(0, tokenTotal - topTokenSum)
      : tokenByAgent.get(item.label) || 0;

  const presentations = items.map((item) =>
    item.label === OTHER_AGENT
      ? { label: t("statsAgentOther"), color: "#8a949c" }
      : AGENT_PRESENTATION[item.label] || {
          label: item.label,
          color: "#59656d",
        }
  );
  const total = items.reduce((sum, item) => sum + item.count, 0);

  // Token 环沿用会话环的分组(同一来源同色),两个扇区才能一一对照。
  let sessionAcc = 0;
  let tokenAcc = 0;
  const sessionStops = [];
  const tokenStops = [];
  items.forEach((item, index) => {
    const color = presentations[index].color;
    if (item.count > 0) {
      const start = (sessionAcc / total) * 100;
      sessionAcc += item.count;
      sessionStops.push(
        `${color} ${start.toFixed(2)}% ${((sessionAcc / total) * 100).toFixed(2)}%`
      );
    }
    const itemTokens = tokensOf(item);
    if (tokenTotal > 0 && itemTokens > 0) {
      const start = (tokenAcc / tokenTotal) * 100;
      tokenAcc += itemTokens;
      tokenStops.push(
        `${color} ${start.toFixed(2)}% ${((tokenAcc / tokenTotal) * 100).toFixed(2)}%`
      );
    }
  });

  const wrap = document.createElement("div");
  wrap.className = "donut-wrap";
  wrap.append(
    donutVisual(
      sessionStops,
      `${t("statsAgentDist")} · ${t("statsMetricSessions")}: ${formatCount(total)}`,
      formatCount(total),
      t("statsMetricSessions")
    ),
    donutVisual(
      tokenStops,
      `${t("statsAgentDist")} · ${t("statsTokenShort")}: ${formatCount(tokenTotal)}`,
      tokenTotal > 0 ? formatTokensCompact(tokenTotal) : "0",
      t("statsTokenShort"),
      tokenTotal > 0 ? formatCount(tokenTotal) : ""
    )
  );
  const legend = document.createElement("div");
  legend.className = "donut-legend";
  items.forEach((item, index) => {
    const presentation = presentations[index];
    const itemTokens = tokensOf(item);
    const row = document.createElement("div");
    row.className = "donut-legend-item";
    const dot = document.createElement("span");
    dot.className = "donut-dot";
    dot.style.background = presentation.color;
    const name = document.createElement("span");
    name.textContent = presentation.label;
    name.title = presentation.label;
    const count = document.createElement("span");
    count.className = "donut-count";
    count.textContent = formatCount(item.count);
    count.title = `${t("statsMetricSessions")} ${formatCount(item.count)} · ${((item.count / total) * 100).toFixed(1)}%`;
    const tokens = document.createElement("span");
    tokens.className = "donut-tokens";
    tokens.textContent = itemTokens ? formatTokensCompact(itemTokens) : "—";
    tokens.title = itemTokens
      ? `${t("statsTokenShort")} ${formatCount(itemTokens)} · ${((itemTokens / tokenTotal) * 100).toFixed(1)}%`
      : "";
    row.append(dot, name, count, tokens);
    legend.append(row);
  });
  wrap.append(legend);
  container.append(wrap);
}

function renderRankings(stats, container) {
  container.replaceChildren();
  // Provider 行附带 token 用量;无 token 统计的条目显示占位符。
  const tokenByProvider = new Map(
    (stats.by_provider_tokens || []).map((item) => [item.label, item.count])
  );
  const sections = [
    {
      title: t("statsCommonProvider"),
      items: stats.by_provider || [],
      kind: "provider",
      tokensOf: (label) => tokenByProvider.get(label) ?? 0,
    },
    {
      title: t("statsCommonCwd"),
      items: (stats.by_cwd || []).slice(0, 8),
      isPath: true,
      kind: "cwd",
    },
  ];
  sections.forEach(({ title, items, isPath, kind, tokensOf }) => {
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
      body.append(
        renderBar(label, count, max, displayLabel, tokensOf?.(label) ?? null)
      );
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
