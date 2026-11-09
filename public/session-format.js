import { getLang, t } from "./i18n.js";

function locale() {
  return getLang() === "zh" ? "zh-CN" : "en";
}

export function formatCount(value) {
  return new Intl.NumberFormat(locale()).format(Number(value || 0));
}

const TOKEN_UNIT_STEPS = [
  { limit: 1_000_000_000, suffix: "B" },
  { limit: 1_000_000, suffix: "M" },
  { limit: 1_000, suffix: "k" },
];

// 卡片与图表轴上的紧凑写法；完整千分位数值放在 title 里。
export function formatTokensCompact(value) {
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

// 成本是内置价目的估算值（USD）：不足 1 美分显示下限提示，
// 大额按整数显示避免长小数；空值/非法值交给调用方显示占位符。
export function formatCost(value) {
  const cost = Number(value);
  if (!Number.isFinite(cost)) return "—";
  if (cost > 0 && cost < 0.01) return "<$0.01";
  return new Intl.NumberFormat(locale(), {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cost >= 100 ? 0 : 2,
  }).format(cost);
}

// 各来源的默认会话形态：普通会话为 cli，Cursor 为 ide。
// 列表里逐行重复没有信息量，只保留 subagent/desktop 这类有区分度的值。
const DEFAULT_SESSION_SOURCES = new Set(["cli", "ide"]);

export function isDefaultSessionSource(source) {
  return DEFAULT_SESSION_SOURCES.has(source);
}

export function formatTimestamp(value) {
  if (!value) return t("unknownTime");

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(locale(), {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

export function formatListTimestamp(value, now = new Date()) {
  if (!value) return t("unknownTime");

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (localDateKey(date) === localDateKey(now)) return time;
  const day = new Intl.DateTimeFormat(locale(), {
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
    month: "short",
    day: "numeric",
  }).format(date);
  return `${day} ${time}`;
}

export function sessionTimestamp(session) {
  return session.last_timestamp || session.timestamp || "";
}

// 文件最近写入在该窗口内视为"进行中"：agent 持续输出时 mtime 紧贴当前时间。
export const RUNNING_WINDOW_MS = 90_000;

export function isSessionRunning(session, now = Date.now()) {
  const mtime = Number(session?.file_mtime_ms || 0);
  return mtime > 0 && now - mtime < RUNNING_WINDOW_MS;
}

// 列表摘要与已打开详情对比：消息数、文件写入时间或最后消息时间变化即需重载。
export function sessionNeedsLiveReload(fresh, current) {
  if (!fresh || !current) return false;
  return (
    Number(fresh.message_count || 0) !== Number(current.message_count || 0) ||
    Number(fresh.file_mtime_ms || 0) !== Number(current.file_mtime_ms || 0) ||
    (fresh.last_timestamp || "") !== (current.last_timestamp || "")
  );
}

// 自定义名称优先，空值回退到原始标题；调用方继续处理空标题兜底。
export function displaySessionTitle(session) {
  return session?.workspace?.display_name || session?.title || "";
}

// 部分来源（如 Cursor）不记录 Provider 但记录模型名，展示时回退到模型名。
export function providerLabel(summary) {
  const provider = summary?.model_provider;
  if (provider && provider !== "unknown") return provider;
  const model = summary?.model;
  if (typeof model === "string" && model) return model;
  return provider || "unknown";
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDateGroup(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return { key: "unknown", label: t("unknownTime") };
  }

  // 统一用本地时区计算日期键：时间字符串可能带 Z 或偏移（UTC 日期），
  // 直接截取前缀会把本地同一天的会话拆到两个分组、凌晨会话标错"今天/昨天"。
  const key = localDateKey(date);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (key === localDateKey(today)) return { key, label: t("today") };
  if (key === localDateKey(yesterday)) return { key, label: t("yesterday") };

  return {
    key,
    label: new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(
      date
    ),
  };
}

export function cwdParts(cwd) {
  if (!cwd) return { main: t("noCwd"), path: "" };
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return { main: parts.at(-1) || cwd, path: cwd };
}

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

export function fillSelect(
  select,
  values,
  labelFor = (value) => value,
  allLabel = t("all")
) {
  const currentValue = select.value;
  select.replaceChildren(createOption("", allLabel));
  values.forEach((value) =>
    select.append(createOption(value, labelFor(value)))
  );
  select.value = values.includes(currentValue) ? currentValue : "";
}

export function compactText(value, maxLength = 90) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
}
