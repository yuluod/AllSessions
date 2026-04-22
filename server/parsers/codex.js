import {
  compareSummariesDesc,
  createRawEventFromRecord,
  fallbackSessionId,
  pushConversationMessage,
  textFromMessageContent
} from "./common.js";

export { compareSummariesDesc };

export function parseCodexContent(content, filePath) {
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
    source_kind: "codex",
    display_source: "Codex",
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

export async function parseCodexFile(filePath) {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(filePath, "utf8");
  return parseCodexContent(content, filePath);
}
