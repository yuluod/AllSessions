import fss from "node:fs";
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
const DEFAULT_DETAIL_MAX_MESSAGES = 800;
const DEFAULT_DETAIL_MAX_RAW_EVENTS = 1_200;
const DEFAULT_DETAIL_MAX_MESSAGE_TEXT_CHARS = 20_000;
const DEFAULT_DETAIL_MAX_RAW_EVENT_LINE_CHARS = 10_000;

class HeadTailCollector {
  constructor(limit) {
    this.limit = Math.max(2, Math.floor(limit));
    this.headLimit = Math.ceil(this.limit / 2);
    this.tailLimit = this.limit - this.headLimit;
    this.head = [];
    this.tail = [];
    this.tailStart = 0;
    this.total = 0;
  }

  add(value) {
    this.total += 1;
    if (this.head.length < this.headLimit) {
      this.head.push(value);
      return;
    }
    if (this.tail.length < this.tailLimit) {
      this.tail.push(value);
      return;
    }
    if (this.tailLimit > 0) {
      this.tail[this.tailStart] = value;
      this.tailStart = (this.tailStart + 1) % this.tailLimit;
    }
  }

  orderedTail() {
    if (this.tail.length < this.tailLimit || this.tailStart === 0) {
      return [...this.tail];
    }
    return [...this.tail.slice(this.tailStart), ...this.tail.slice(0, this.tailStart)];
  }

  result(markerFactory) {
    const tail = this.orderedTail();
    const omitted = Math.max(0, this.total - this.head.length - tail.length);
    const values = omitted > 0
      ? [...this.head, markerFactory(omitted), ...tail]
      : [...this.head, ...tail];
    return { values, omitted, total: this.total };
  }
}

function detailLimit(value, fallback) {
  return Number.isFinite(value) ? Math.max(2, Math.floor(value)) : fallback;
}

function truncateConversationMessage(message, maxTextChars) {
  if (message.text.length <= maxTextChars) return message;
  return {
    ...message,
    text: message.text.slice(0, maxTextChars),
    text_truncated: true,
    original_text_chars: message.text.length
  };
}

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

function normalizeConversationMessage(messageData) {
  const normalized = [];
  pushConversationMessage(normalized, messageData);
  return normalized[0] || null;
}

function isDuplicateMessageRecord(previous, current) {
  if (!previous || !current || previous.role !== current.role || previous.text !== current.text) {
    return false;
  }

  const sourceTypes = new Set([previous.source_type, current.source_type]);
  if (!sourceTypes.has("event_msg") || !sourceTypes.has("response_item")) {
    return false;
  }

  const eventMessage = previous.source_type === "event_msg" ? previous : current;
  const responseMessage = previous.source_type === "response_item" ? previous : current;
  if (responseMessage.source_subtype !== "message") {
    return false;
  }

  return (current.role === "user" && eventMessage.source_subtype === "user_message") ||
    (current.role === "assistant" && eventMessage.source_subtype === "agent_message");
}

function appendConversationMessage(target, messageData) {
  const message = normalizeConversationMessage(messageData);
  if (!message || isDuplicateMessageRecord(target.at(-1), message)) {
    return null;
  }
  target.push(message);
  return message;
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
      appendConversationMessage(conversationMessages, conversationMessage);
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

export async function parseCodexFile(filePath, options = {}) {
  const maxConversationMessages = detailLimit(
    options.maxConversationMessages,
    DEFAULT_DETAIL_MAX_MESSAGES
  );
  const maxRawEvents = detailLimit(options.maxRawEvents, DEFAULT_DETAIL_MAX_RAW_EVENTS);
  const maxMessageTextChars = detailLimit(
    options.maxMessageTextChars,
    DEFAULT_DETAIL_MAX_MESSAGE_TEXT_CHARS
  );
  const maxRawEventLineChars = detailLimit(
    options.maxRawEventLineChars,
    DEFAULT_DETAIL_MAX_RAW_EVENT_LINE_CHARS
  );
  const messageCollector = new HeadTailCollector(maxConversationMessages);
  const rawEventCollector = new HeadTailCollector(maxRawEvents);
  const accumulator = createConversationSummaryAccumulator();
  const toolCallNamesById = new Map();
  const input = fss.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  let metaRecord = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let previousMessage = null;
  let lineNumber = 0;
  let eventCount = 0;
  let truncatedMessageCount = 0;
  let truncatedRawEventCount = 0;

  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    eventCount += 1;

    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      rawEventCollector.add({
        line_number: lineNumber,
        timestamp: null,
        type: "parse_error",
        payload: {
          message: "JSON parse error",
          raw_line: line.slice(0, maxRawEventLineChars),
          raw_line_truncated: line.length > maxRawEventLineChars,
          error: error instanceof Error ? error.message : String(error)
        }
      });
      continue;
    }

    const rawEvent = createRawEventFromRecord(record, lineNumber);
    if (line.length > maxRawEventLineChars) {
      rawEvent.payload = {
        truncated: true,
        original_characters: line.length,
        record_type: rawEvent.type
      };
      truncatedRawEventCount += 1;
    }
    rawEventCollector.add(rawEvent);

    if (rawEvent.timestamp && !firstTimestamp) firstTimestamp = rawEvent.timestamp;
    if (rawEvent.timestamp) lastTimestamp = rawEvent.timestamp;
    if (!metaRecord && record.type === "session_meta" && record.payload && typeof record.payload === "object") {
      metaRecord = record.payload;
    }

    const messageData = conversationMessageFromRecord(record, rawEvent.timestamp, toolCallNamesById);
    const message = messageData ? normalizeConversationMessage(messageData) : null;
    if (!message || isDuplicateMessageRecord(previousMessage, message)) continue;
    previousMessage = message;

    const boundedMessage = truncateConversationMessage(message, maxMessageTextChars);
    if (boundedMessage.text_truncated) truncatedMessageCount += 1;
    addConversationMessageToSummary(accumulator, boundedMessage);
    messageCollector.add(boundedMessage);
  }

  const messages = messageCollector.result((omitted) => ({
    role: "system",
    text: "",
    timestamp: null,
    source_type: "viewer",
    source_subtype: "truncation",
    is_truncation_marker: true,
    omitted_count: omitted
  }));
  const rawEvents = rawEventCollector.result((omitted) => ({
    line_number: null,
    timestamp: null,
    type: "viewer_truncation",
    payload: { omitted_events: omitted }
  }));
  const summary = createCodexSummary({
    filePath,
    metaRecord,
    firstTimestamp,
    lastTimestamp,
    eventCount
  });
  finalizeSessionSummaryFromAggregate(summary, accumulator);

  const detailTruncated = messages.omitted > 0 ||
    rawEvents.omitted > 0 ||
    truncatedMessageCount > 0 ||
    truncatedRawEventCount > 0;
  if (detailTruncated) summary.detail_truncated = true;

  return {
    summary,
    raw_events: rawEvents.values,
    conversation_messages: messages.values,
    truncation: {
      truncated: detailTruncated,
      messages: {
        total: messages.total,
        omitted: messages.omitted,
        text_truncated: truncatedMessageCount
      },
      raw_events: {
        total: rawEvents.total,
        omitted: rawEvents.omitted,
        payloads_truncated: truncatedRawEventCount
      }
    }
  };
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
  remainingTextChars,
  previousMessage
}) {
  const message = normalizeConversationMessage(messageData);
  if (!message || isDuplicateMessageRecord(previousMessage, message)) {
    return { remainingTextChars, previousMessage };
  }

  addConversationMessageToSummary(accumulator, message);
  if (remainingTextChars <= 0) {
    return { remainingTextChars: 0, previousMessage: message };
  }

  const text = detachedTextPrefix(message.text, remainingTextChars);
  if (text) conversationMessages.push({ ...message, text });
  return {
    remainingTextChars: Math.max(0, remainingTextChars - text.length),
    previousMessage: message
  };
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
  let previousMessage = null;

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
      const collected = collectSummaryMessage({
        messageData,
        accumulator,
        conversationMessages,
        remainingTextChars,
        previousMessage
      });
      remainingTextChars = collected.remainingTextChars;
      previousMessage = collected.previousMessage;
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
