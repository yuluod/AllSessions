import { downloadBlob, redactText } from "./session-export.js";

// 只导出聚合指标；项目回顾含会话标题、备注等正文，不进入统计导出。
const BREAKDOWN_FIELDS = [
  "by_agent",
  "by_agent_tokens",
  "by_source_kind",
  "by_provider",
  "by_provider_tokens",
  "by_model_tokens",
  "by_cwd",
  "by_tool",
  "by_command",
];

const TOTAL_FIELDS = [
  "total",
  "total_events",
  "total_messages",
  "total_tool_calls",
  "total_tokens",
  "total_input_tokens",
  "total_output_tokens",
  "total_cached_input_tokens",
  "total_cache_read_tokens",
  "total_cache_write_tokens",
  "cache_eligible_input_tokens",
  "usage_sessions",
  "tool_sessions",
  "undated_tokens",
  "total_cost",
  "cost_sessions",
  "unpriced_tokens",
  "active_days",
];

// 工作目录本身就是路径，不能依赖路径模式匹配（挂载盘、UNC 等会漏掉），整体替换并保留序号区分。
function redactLabel(field, label, index) {
  if (field === "by_cwd") return label ? `[local path ${index + 1}]` : label;
  return redactText(label);
}

function breakdownRows(stats, redact) {
  const rows = [];
  for (const field of BREAKDOWN_FIELDS) {
    (stats[field] || []).forEach((item, index) => {
      const label = String(item.label ?? "");
      rows.push({
        dimension: field,
        label: redact ? redactLabel(field, label, index) : label,
        count: item.count ?? null,
      });
    });
  }
  return rows;
}

export function statsExportData(stats, { redact = false } = {}) {
  const totals = {};
  for (const field of TOTAL_FIELDS) totals[field] = stats[field] ?? null;
  const breakdowns = {};
  for (const row of breakdownRows(stats, redact)) {
    (breakdowns[row.dimension] ||= []).push({
      label: row.label,
      count: row.count,
    });
  }
  return {
    range: {
      start: stats.range?.start ?? null,
      end: stats.range?.end ?? null,
    },
    redacted: redact,
    totals,
    by_date: (stats.by_date || []).map((day) => ({
      date: day.label,
      sessions: day.count ?? 0,
      tokens: day.tokens ?? null,
      cost: day.cost ?? null,
    })),
    ...breakdowns,
  };
}

// 以 = + - @ 或控制符开头的文本会被表格软件当作公式执行，先加单引号。
export function csvCell(value) {
  if (value == null) return "";
  if (typeof value === "number") return String(value);
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(header, rows) {
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function statsDailyCsv(stats) {
  return csv(
    ["date", "sessions", "tokens", "cost_usd"],
    (stats.by_date || []).map((day) => [
      day.label,
      day.count ?? 0,
      day.tokens ?? null,
      day.cost ?? null,
    ])
  );
}

export function statsBreakdownCsv(stats, { redact = false } = {}) {
  return csv(
    ["dimension", "label", "count"],
    breakdownRows(stats, redact).map((row) => [
      row.dimension,
      row.label,
      row.count,
    ])
  );
}

function exportFilename(stats, kind, extension, redact) {
  const start = stats.range?.start || "all";
  const end = stats.range?.end || "now";
  const suffix = redact ? "-redacted" : "";
  return `allsessions-stats-${kind}-${start}_${end}${suffix}.${extension}`;
}

export function exportStats(stats, format, { redact = false } = {}) {
  if (!stats) return;
  if (format === "json") {
    downloadBlob(
      `${JSON.stringify(statsExportData(stats, { redact }), null, 2)}\n`,
      exportFilename(stats, "summary", "json", redact),
      "application/json"
    );
  } else if (format === "daily-csv") {
    downloadBlob(
      `\uFEFF${statsDailyCsv(stats)}`,
      exportFilename(stats, "daily", "csv", redact),
      "text/csv"
    );
  } else if (format === "breakdown-csv") {
    downloadBlob(
      `\uFEFF${statsBreakdownCsv(stats, { redact })}`,
      exportFilename(stats, "breakdown", "csv", redact),
      "text/csv"
    );
  }
}
