// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/g;

export function sanitizeQueryValue(value) {
  if (!value) return "";
  const cleaned = String(value).replace(CONTROL_CHAR_RE, "");
  return cleaned.length > 256 ? cleaned.slice(0, 256) : cleaned;
}

function isEnabled(value) {
  return value === true || value === "true" || value === "1";
}

export function dateKeyFromTimestamp(timestamp) {
  if (typeof timestamp !== "string" || timestamp.length < 10) return "";
  return timestamp.slice(0, 10);
}

export function readSessionFilters(searchParams) {
  return {
    provider: sanitizeQueryValue(searchParams.get("provider")),
    source_kind: sanitizeQueryValue(searchParams.get("source_kind")),
    date: sanitizeQueryValue(searchParams.get("date")),
    cwd: sanitizeQueryValue(searchParams.get("cwd")),
    show_codex_archived: isEnabled(searchParams.get("show_codex_archived")),
    show_hidden: isEnabled(searchParams.get("show_hidden"))
  };
}

export function readPageLimit(searchParams, {
  name = "limit",
  defaultValue = 50,
  max = 200
} = {}) {
  const parsed = Number.parseInt(searchParams.get(name) || "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, max);
}

export function matchesSessionFilters(summary, filters = {}) {
  if (summary.archived === true &&
    summary.archive_source === "codex" &&
    !isEnabled(filters.show_codex_archived)) {
    return false;
  }
  if (summary.hidden === true && !isEnabled(filters.show_hidden)) return false;
  if (filters.provider && summary.model_provider !== filters.provider) return false;
  if (filters.source_kind && summary.source_kind !== filters.source_kind) return false;
  if (filters.date && dateKeyFromTimestamp(summary.timestamp || summary.last_timestamp) !== filters.date) {
    return false;
  }
  if (filters.cwd && summary.cwd !== filters.cwd) return false;
  return true;
}
