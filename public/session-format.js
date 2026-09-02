import { getLang, t } from "./i18n.js";

function locale() {
  return getLang() === "zh" ? "zh-CN" : "en";
}

export function formatCount(value) {
  return new Intl.NumberFormat(locale()).format(Number(value || 0));
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

export function formatListTimestamp(value) {
  if (!value) return t("unknownTime");

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function sessionTimestamp(session) {
  return session.last_timestamp || session.timestamp || "";
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

export function fillSelect(select, values, labelFor = (value) => value) {
  const currentValue = select.value;
  select.replaceChildren(createOption("", t("all")));
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
