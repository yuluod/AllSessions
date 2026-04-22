import fs from "node:fs/promises";
import path from "node:path";

function textFromContentItem(item) {
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

function textFromMessageContent(content) {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => textFromContentItem(item))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function normalizeRole(role) {
  if (!role || typeof role !== "string") {
    return "unknown";
  }

  return role;
}

function fallbackSessionId(filePath) {
  const baseName = path.basename(filePath, path.extname(filePath));
  const pieces = baseName.split("-");

  return pieces.at(-1) || baseName;
}

function sortTimestampValue(value) {
  if (!value) {
    return 0;
  }

  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function pushConversationMessage(target, { role, text, timestamp, sourceType, sourceSubtype }) {
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

function createRawEventFromRecord(record, lineNumber) {
  return {
    line_number: lineNumber,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
    type: typeof record.type === "string" ? record.type : "unknown",
    payload: record.payload ?? null
  };
}

export function parseSessionContent(content, filePath) {
  const lines = content.split(/\r?\n/);
  const rawEvents = [];
  const conversationMessages = [];

  let metaRecord = null;
  let firstTimestamp = null;
  let lastTimestamp = null;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (!line.trim()) {
      return;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      rawEvents.push({
        line_number: lineNumber,
        timestamp: null,
        type: "parse_error",
        payload: {
          message: "JSON parse error",
          raw_line: line,
          error: error instanceof Error ? error.message : String(error)
        }
      });
      return;
    }

    const rawEvent = createRawEventFromRecord(record, lineNumber);
    rawEvents.push(rawEvent);

    if (rawEvent.timestamp && !firstTimestamp) {
      firstTimestamp = rawEvent.timestamp;
    }
    if (rawEvent.timestamp) {
      lastTimestamp = rawEvent.timestamp;
    }

    if (!metaRecord && record.type === "session_meta" && record.payload && typeof record.payload === "object") {
      metaRecord = record.payload;
    }

    if (record.type === "response_item" && record.payload && typeof record.payload === "object") {
      if (record.payload.type === "message") {
        const text = textFromMessageContent(record.payload.content);
        pushConversationMessage(conversationMessages, {
          role: record.payload.role || "assistant",
          text,
          timestamp: rawEvent.timestamp,
          sourceType: record.type,
          sourceSubtype: record.payload.type
        });
      }
      return;
    }

    if (record.type === "event_msg" && record.payload && typeof record.payload === "object") {
      if (record.payload.type === "agent_message") {
        pushConversationMessage(conversationMessages, {
          role: "assistant",
          text: record.payload.message,
          timestamp: rawEvent.timestamp,
          sourceType: record.type,
          sourceSubtype: record.payload.type
        });
      } else if (record.payload.type === "user_message") {
        pushConversationMessage(conversationMessages, {
          role: "user",
          text: record.payload.message,
          timestamp: rawEvent.timestamp,
          sourceType: record.type,
          sourceSubtype: record.payload.type
        });
      } else if (record.payload.type === "tool_call") {
        const toolName = record.payload.tool_name || record.payload.name || "unknown_tool";
        const toolArgs = typeof record.payload.arguments === "string"
          ? record.payload.arguments
          : JSON.stringify(record.payload.arguments ?? record.payload.input ?? {});
        pushConversationMessage(conversationMessages, {
          role: "tool",
          text: `[${toolName}] ${toolArgs}`,
          timestamp: rawEvent.timestamp,
          sourceType: record.type,
          sourceSubtype: record.payload.type
        });
      } else if (record.payload.type === "tool_result") {
        const output = typeof record.payload.output === "string"
          ? record.payload.output
          : JSON.stringify(record.payload.output ?? record.payload.content ?? {});
        pushConversationMessage(conversationMessages, {
          role: "tool",
          text: output,
          timestamp: rawEvent.timestamp,
          sourceType: record.type,
          sourceSubtype: record.payload.type
        });
      } else if (record.payload.type === "error") {
        const errorMsg = record.payload.message || record.payload.error || JSON.stringify(record.payload);
        pushConversationMessage(conversationMessages, {
          role: "system",
          text: `Error: ${errorMsg}`,
          timestamp: rawEvent.timestamp,
          sourceType: record.type,
          sourceSubtype: record.payload.type
        });
      }
    }
  });

  const sessionId =
    (metaRecord && typeof metaRecord.id === "string" && metaRecord.id) || fallbackSessionId(filePath);

  const summaryTimestamp =
    (metaRecord && typeof metaRecord.timestamp === "string" && metaRecord.timestamp) || firstTimestamp;

  const summary = {
    id: sessionId,
    timestamp: summaryTimestamp,
    model_provider:
      (metaRecord && typeof metaRecord.model_provider === "string" && metaRecord.model_provider) || "unknown",
    cwd: (metaRecord && typeof metaRecord.cwd === "string" && metaRecord.cwd) || "",
    source: (metaRecord && typeof metaRecord.source === "string" && metaRecord.source) || "",
    originator:
      (metaRecord && typeof metaRecord.originator === "string" && metaRecord.originator) || "",
    file_path: filePath,
    event_count: rawEvents.length,
    last_timestamp: lastTimestamp || summaryTimestamp || null
  };

  return {
    summary,
    raw_events: rawEvents,
    conversation_messages: conversationMessages
  };
}

export async function parseSessionFile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return parseSessionContent(content, filePath);
}

export function compareSummariesDesc(left, right) {
  return sortTimestampValue(right.timestamp || right.last_timestamp) -
    sortTimestampValue(left.timestamp || left.last_timestamp);
}
