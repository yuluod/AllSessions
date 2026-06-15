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

function compactText(text, maxLength) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
}

function projectNameFromCwd(cwd) {
  if (!cwd || typeof cwd !== "string") {
    return "";
  }
  return path.basename(cwd) || cwd;
}

export function enrichSummaryFromConversation(summary, messages) {
  const roleCounts = {};
  for (const message of messages) {
    const role = normalizeRole(message.role);
    roleCounts[role] = (roleCounts[role] || 0) + 1;
  }

  const firstUser = messages.find((message) => message.role === "user");
  const firstAssistant = messages.find((message) => message.role === "assistant");
  const firstMessage = messages[0];

  summary.title =
    compactText(firstUser?.text, 90) ||
    projectNameFromCwd(summary.cwd) ||
    summary.id;
  summary.preview_text = compactText(firstAssistant?.text || firstMessage?.text || "", 160);
  summary.message_count = messages.length;
  summary.role_counts = roleCounts;
  summary.tool_count = roleCounts.tool || 0;

  return summary;
}

export function finalizeSessionSummary(summary, messages) {
  summary.id = typeof summary.id === "string" && summary.id ? summary.id : "unknown";
  summary.source_kind = typeof summary.source_kind === "string" ? summary.source_kind : "";
  summary.display_source = typeof summary.display_source === "string" ? summary.display_source : summary.source_kind;
  summary.timestamp = typeof summary.timestamp === "string" ? summary.timestamp : null;
  summary.model_provider =
    typeof summary.model_provider === "string" && summary.model_provider ? summary.model_provider : "unknown";
  summary.cwd = typeof summary.cwd === "string" ? summary.cwd : "";
  summary.source = typeof summary.source === "string" ? summary.source : "";
  summary.originator = typeof summary.originator === "string" ? summary.originator : "";
  summary.file_path = typeof summary.file_path === "string" ? summary.file_path : "";
  summary.event_count = Number.isFinite(summary.event_count) ? summary.event_count : 0;
  summary.last_timestamp =
    typeof summary.last_timestamp === "string" && summary.last_timestamp ? summary.last_timestamp : summary.timestamp;

  return enrichSummaryFromConversation(summary, messages);
}

export function pushConversationMessage(
  target,
  { role, text, timestamp, sourceType, sourceSubtype, toolName, toolKind, toolCallId }
) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) {
    return;
  }
  const message = {
    role: normalizeRole(role),
    text: trimmed,
    timestamp: typeof timestamp === "string" ? timestamp : null,
    source_type: sourceType,
    source_subtype: sourceSubtype || null
  };
  if (toolName) {
    message.tool_name = toolName;
  }
  if (toolKind) {
    message.tool_kind = toolKind;
  }
  if (toolCallId) {
    message.tool_call_id = toolCallId;
  }
  target.push(message);
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
