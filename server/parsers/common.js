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

function isSyntheticUserContext(text) {
  const value = String(text || "").trimStart();
  return /^<(?:recommended_plugins|permissions instructions|app-context|collaboration_mode|environment_context|skills_instructions|apps_instructions|plugins_instructions)(?:>|\s)/i.test(value) ||
    /^#\s*AGENTS\.md instructions\b/i.test(value) ||
    /^#\s*Files mentioned by the user:\s*/i.test(value);
}

export function createConversationSummaryAccumulator() {
  return {
    message_count: 0,
    role_counts: {},
    first_user_text: "",
    first_assistant_text: "",
    first_message_text: ""
  };
}

export function addConversationMessageToSummary(accumulator, message) {
  const role = normalizeRole(message.role);
  accumulator.message_count += 1;
  accumulator.role_counts[role] = (accumulator.role_counts[role] || 0) + 1;
  if (!accumulator.first_message_text) {
    accumulator.first_message_text = compactText(message.text, 160);
  }
  if (role === "user" && !accumulator.first_user_text) {
    if (!isSyntheticUserContext(message.text)) {
      accumulator.first_user_text = compactText(message.text, 90);
    }
  }
  if (role === "assistant" && !accumulator.first_assistant_text) {
    accumulator.first_assistant_text = compactText(message.text, 160);
  }
  return accumulator;
}

export function enrichSummaryFromConversationAggregate(summary, accumulator) {
  summary.title =
    accumulator.first_user_text ||
    projectNameFromCwd(summary.cwd) ||
    summary.id;
  summary.preview_text = accumulator.first_assistant_text || accumulator.first_message_text || "";
  summary.message_count = accumulator.message_count;
  summary.role_counts = { ...accumulator.role_counts };
  summary.tool_count = accumulator.role_counts.tool || 0;

  return summary;
}

export function enrichSummaryFromConversation(summary, messages) {
  const accumulator = createConversationSummaryAccumulator();
  for (const message of messages) {
    addConversationMessageToSummary(accumulator, message);
  }
  return enrichSummaryFromConversationAggregate(summary, accumulator);
}

function normalizeSessionSummary(summary) {
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

  return summary;
}

export function finalizeSessionSummary(summary, messages) {
  normalizeSessionSummary(summary);

  return enrichSummaryFromConversation(summary, messages);
}

export function finalizeSessionSummaryFromAggregate(summary, accumulator) {
  normalizeSessionSummary(summary);
  return enrichSummaryFromConversationAggregate(summary, accumulator);
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
