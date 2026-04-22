import path from "node:path";

export function textFromContentItem(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  if (typeof item.text === "string" && item.text.trim()) {
    return item.text.trim();
  }
  if (Array.isArray(item.summary)) {
    return item.summary
      .map((entry) => textFromContentItem(entry))
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  if (typeof item.content === "string" && item.content.trim()) {
    return item.content.trim();
  }
  return "";
}

export function textFromMessageContent(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => textFromContentItem(item))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function normalizeRole(role) {
  if (!role || typeof role !== "string") {
    return "unknown";
  }
  return role;
}

export function fallbackSessionId(filePath) {
  const baseName = path.basename(filePath, path.extname(filePath));
  const pieces = baseName.split("-");
  return pieces.at(-1) || baseName;
}

export function sortTimestampValue(value) {
  if (!value) {
    return 0;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

export function pushConversationMessage(target, { role, text, timestamp, sourceType, sourceSubtype }) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) {
    return;
  }
  target.push({
    role: normalizeRole(role),
    text: trimmed,
    timestamp: typeof timestamp === "string" ? timestamp : null,
    source_type: sourceType,
    source_subtype: sourceSubtype || null
  });
}

export function createRawEventFromRecord(record, lineNumber) {
  return {
    line_number: lineNumber,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
    type: typeof record.type === "string" ? record.type : "unknown",
    payload: record.payload ?? null
  };
}

export function compareSummariesDesc(left, right) {
  return sortTimestampValue(right.timestamp || right.last_timestamp) -
    sortTimestampValue(left.timestamp || left.last_timestamp);
}
