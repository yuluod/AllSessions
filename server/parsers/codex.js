import fss from "node:fs";
import fs from "node:fs/promises";
import readline from "node:readline";

import {
  addConversationMessageToSummary,
  compareSummariesDesc,
  createConversationSummaryAccumulator,
  createRawEventFromRecord,
  fallbackSessionId,
  finalizeSessionSummary,
  finalizeSessionSummaryFromAggregate,
  pushConversationMessage,
  textFromMessageContent
} from "./common.js";

export { compareSummariesDesc };

const DEFAULT_SUMMARY_TEXT_CHARS = 200_000;

function readSourceMetadata(metaRecord) {
  const source = metaRecord?.source;
  if (typeof source === "string") {
    return { source };
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { source: "" };
  }

  const hasSubagent = Boolean(source.subagent);
  return {
    source: hasSubagent ? "subagent" : "object",
    source_detail: source,
    hidden: hasSubagent,
    hidden_reason: hasSubagent ? "subagent" : ""
  };
}

function conversationMessageFromRecord(record, timestamp, toolCallNamesById) {
  const payload = record?.payload;
  if (!payload || typeof payload !== "object") return null;

  if (record.type === "response_item") {
    if (payload.type === "message") {
      return {
        role: payload.role || "assistant",
        text: textFromMessageContent(payload.content),
        timestamp,
        sourceType: record.type,
        sourceSubtype: payload.type
      };
    }
    if (payload.type === "function_call") {
      const toolName = payload.name || payload.tool_name || "unknown_tool";
      const toolCallId = payload.call_id || payload.id || "";
      if (toolCallId) toolCallNamesById.set(toolCallId, toolName);
      return {
        role: "tool",
        text: `[${toolName}] ${typeof payload.arguments === "string"
          ? payload.arguments
          : JSON.stringify(payload.arguments ?? payload.input ?? {})}`,
        timestamp,
        sourceType: record.type,
        sourceSubtype: payload.type,
        toolName,
        toolKind: "tool_call",
        toolCallId
      };
    }
    if (payload.type === "function_call_output") {
      const toolCallId = payload.call_id || payload.id || "";
      const toolName = payload.tool_name ||
        payload.name ||
        (toolCallId && toolCallNamesById.get(toolCallId)) ||
        toolCallId ||
        "tool_result";
      return {
        role: "tool",
        text: typeof payload.output === "string"
          ? payload.output
          : JSON.stringify(payload.output ?? payload.content ?? {}),
        timestamp,
        sourceType: record.type,
        sourceSubtype: payload.type,
        toolName,
        toolKind: "tool_result",
        toolCallId
      };
    }
    return null;
  }

  if (record.type !== "event_msg") return null;
  if (payload.type === "agent_message") {
    return {
      role: "assistant",
      text: payload.message,
      timestamp,
      sourceType: record.type,
      sourceSubtype: payload.type
    };
  }
  if (payload.type === "user_message") {
    return {
      role: "user",
      text: payload.message,
      timestamp,
      sourceType: record.type,
      sourceSubtype: payload.type
    };
  }
  if (payload.type === "tool_call") {
    const toolName = payload.tool_name || payload.name || "unknown_tool";
    const toolCallId = payload.call_id || payload.id || "";
    if (toolCallId) toolCallNamesById.set(toolCallId, toolName);
    return {
      role: "tool",
      text: `[${toolName}] ${typeof payload.arguments === "string"
        ? payload.arguments
        : JSON.stringify(payload.arguments ?? payload.input ?? {})}`,
      timestamp,
      sourceType: record.type,
      sourceSubtype: payload.type,
      toolName,
      toolKind: payload.type,
      toolCallId
    };
  }
  if (payload.type === "tool_result") {
    const toolCallId = payload.call_id || payload.id || "";
    const toolName = payload.tool_name ||
      payload.name ||
      (toolCallId && toolCallNamesById.get(toolCallId)) ||
      toolCallId ||
      "tool_result";
    return {
      role: "tool",
      text: typeof payload.output === "string"
        ? payload.output
        : JSON.stringify(payload.output ?? payload.content ?? {}),
      timestamp,
      sourceType: record.type,
      sourceSubtype: payload.type,
      toolName,
      toolKind: payload.type,
      toolCallId
    };
  }
  if (payload.type === "error") {
    return {
      role: "system",
      text: `Error: ${payload.message || payload.error || JSON.stringify(payload)}`,
      timestamp,
      sourceType: record.type,
      sourceSubtype: payload.type
    };
  }
  return null;
}

function createCodexSummary({ filePath, metaRecord, firstTimestamp, lastTimestamp, eventCount }) {
  const sessionId =
    (metaRecord && typeof metaRecord.id === "string" && metaRecord.id) || fallbackSessionId(filePath);
  const summaryTimestamp =
    (metaRecord && typeof metaRecord.timestamp === "string" && metaRecord.timestamp) || firstTimestamp;
  const sourceMetadata = readSourceMetadata(metaRecord);
  const summary = {
    id: sessionId,
    source_kind: "codex",
    display_source: "Codex",
    timestamp: summaryTimestamp,
    model_provider:
      (metaRecord && typeof metaRecord.model_provider === "string" && metaRecord.model_provider) || "unknown",
    cwd: (metaRecord && typeof metaRecord.cwd === "string" && metaRecord.cwd) || "",
    source: sourceMetadata.source,
    originator:
      (metaRecord && typeof metaRecord.originator === "string" && metaRecord.originator) || "",
    file_path: filePath,
    event_count: eventCount,
    last_timestamp: lastTimestamp || summaryTimestamp || null
  };
  if (sourceMetadata.source_detail) summary.source_detail = sourceMetadata.source_detail;
  if (sourceMetadata.hidden) {
    summary.hidden = true;
    summary.hidden_reason = sourceMetadata.hidden_reason;
  }
  return summary;
}

function markArchivedSummary(summary) {
  summary.source_kind = "codex_archived";
  summary.display_source = "Codex Archived";
  summary.archived = true;
  summary.archive_source = "codex";
  return summary;
}

export function parseCodexContent(content, filePath) {
  const lines = content.split(/\r?\n/);
  const rawEvents = [];
  const conversationMessages = [];

  let metaRecord = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  const toolCallNamesById = new Map();

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

    const conversationMessage = conversationMessageFromRecord(
      record,
      rawEvent.timestamp,
      toolCallNamesById
    );
    if (conversationMessage) {
      pushConversationMessage(conversationMessages, conversationMessage);
    }
  });

  const summary = createCodexSummary({
    filePath,
    metaRecord,
    firstTimestamp,
    lastTimestamp,
    eventCount: rawEvents.length
  });
  finalizeSessionSummary(summary, conversationMessages);

  return {
    summary,
    raw_events: rawEvents,
    conversation_messages: conversationMessages
  };
}

export async function parseCodexFile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return parseCodexContent(content, filePath);
}

export async function parseCodexArchivedFile(filePath) {
  const detail = await parseCodexFile(filePath);
  markArchivedSummary(detail.summary);
  return detail;
}

function detachedTextPrefix(text, maxLength) {
  const prefix = String(text).slice(0, maxLength);
  return Buffer.from(prefix, "utf8").toString("utf8");
}

function collectSummaryMessage({
  messageData,
  accumulator,
  conversationMessages,
  remainingTextChars
}) {
  const normalized = [];
  pushConversationMessage(normalized, messageData);
  const message = normalized[0];
  if (!message) return remainingTextChars;

  addConversationMessageToSummary(accumulator, message);
  if (remainingTextChars <= 0) return 0;

  const text = detachedTextPrefix(message.text, remainingTextChars);
  if (text) conversationMessages.push({ ...message, text });
  return Math.max(0, remainingTextChars - text.length);
}

async function parseCodexSummaryFile(
  filePath,
  { archived = false, maxConversationTextChars = DEFAULT_SUMMARY_TEXT_CHARS } = {}
) {
  const input = fss.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const conversationMessages = [];
  const accumulator = createConversationSummaryAccumulator();
  const toolCallNamesById = new Map();
  const textLimit = Number.isFinite(maxConversationTextChars)
    ? Math.max(0, Math.floor(maxConversationTextChars))
    : DEFAULT_SUMMARY_TEXT_CHARS;

  let remainingTextChars = textLimit;
  let eventCount = 0;
  let metaRecord = null;
  let firstTimestamp = null;
  let lastTimestamp = null;

  for await (const line of lines) {
    if (!line.trim()) continue;
    eventCount += 1;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
    if (timestamp && !firstTimestamp) firstTimestamp = timestamp;
    if (timestamp) lastTimestamp = timestamp;
    if (!metaRecord && record.type === "session_meta" && record.payload && typeof record.payload === "object") {
      metaRecord = record.payload;
    }

    const messageData = conversationMessageFromRecord(record, timestamp, toolCallNamesById);
    if (messageData) {
      remainingTextChars = collectSummaryMessage({
        messageData,
        accumulator,
        conversationMessages,
        remainingTextChars
      });
    }
  }

  const summary = createCodexSummary({
    filePath,
    metaRecord,
    firstTimestamp,
    lastTimestamp,
    eventCount
  });
  if (archived) markArchivedSummary(summary);
  finalizeSessionSummaryFromAggregate(summary, accumulator);

  return {
    summary,
    raw_events: [],
    conversation_messages: conversationMessages
  };
}

export async function parseCodexFileSummary(filePath, options = {}) {
  return parseCodexSummaryFile(filePath, options);
}

export async function parseCodexArchivedFileSummary(filePath, options = {}) {
  return parseCodexSummaryFile(filePath, { ...options, archived: true });
}
