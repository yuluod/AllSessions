import fss from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import {
  addConversationMessageToSummary,
  createConversationSummaryAccumulator,
  finalizeSessionSummary,
  finalizeSessionSummaryFromAggregate,
  pushConversationMessage
} from "./common.js";

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

  result(markerFactory) {
    const tail = this.tail.length < this.tailLimit || this.tailStart === 0
      ? [...this.tail]
      : [...this.tail.slice(this.tailStart), ...this.tail.slice(0, this.tailStart)];
    const omitted = Math.max(0, this.total - this.head.length - tail.length);
    return {
      values: omitted > 0 ? [...this.head, markerFactory(omitted), ...tail] : [...this.head, ...tail],
      omitted,
      total: this.total
    };
  }
}

function detailLimit(value, fallback) {
  return Number.isFinite(value) ? Math.max(2, Math.floor(value)) : fallback;
}

function msToIso(ms) {
  try {
    return new Date(Number(ms)).toISOString();
  } catch {
    return null;
  }
}

function stringifyValue(value) {
  if (typeof value === "string") return value.trim();
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function contentText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((item) => contentText(item)).filter(Boolean).join("\n\n").trim();
  }
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text.trim();
  if (typeof value.thinking === "string") return value.thinking.trim();
  if ("content" in value) return contentText(value.content);
  return "";
}

function messageMetadata(record, message, forceSidechain = false) {
  return {
    uuid: typeof record.uuid === "string" ? record.uuid : "",
    parentUuid: typeof record.parentUuid === "string" ? record.parentUuid : "",
    sidechain: forceSidechain || record.isSidechain === true,
    model: typeof message?.model === "string" ? message.model : "",
    usage: message?.usage && typeof message.usage === "object" ? message.usage : null
  };
}

function appendMessage(target, data) {
  const normalized = [];
  pushConversationMessage(normalized, data);
  if (normalized[0]) target.push(normalized[0]);
}

function conversationMessagesFromRecord(record, toolCallNamesById, { forceSidechain = false } = {}) {
  const messages = [];
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
  const message = record.message;

  if ((record.type === "user" || record.type === "assistant") && message && typeof message === "object") {
    const role = typeof message.role === "string" ? message.role : record.type;
    const common = messageMetadata(record, message, forceSidechain);
    const syntheticRecord = record.isMeta === true || record.isSidechain === true || forceSidechain;
    const blocks = Array.isArray(message.content) ? message.content : [message.content];

    for (const block of blocks) {
      if (typeof block === "string") {
        appendMessage(messages, {
          role,
          text: block,
          timestamp,
          sourceType: record.type,
          sourceSubtype: "text",
          syntheticContext: syntheticRecord,
          ...common
        });
        continue;
      }
      if (!block || typeof block !== "object") continue;

      if (block.type === "tool_use") {
        const toolName = typeof block.name === "string" && block.name ? block.name : "unknown_tool";
        const toolCallId = typeof block.id === "string" ? block.id : "";
        if (toolCallId) toolCallNamesById.set(toolCallId, toolName);
        appendMessage(messages, {
          role: "tool",
          text: `[${toolName}] ${stringifyValue(block.input ?? {})}`,
          timestamp,
          sourceType: record.type,
          sourceSubtype: block.type,
          toolName,
          toolKind: "tool_call",
          toolCallId,
          syntheticContext: syntheticRecord,
          ...common
        });
        continue;
      }

      if (block.type === "tool_result") {
        const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const toolName = (toolCallId && toolCallNamesById.get(toolCallId)) || toolCallId || "tool_result";
        appendMessage(messages, {
          role: "tool",
          text: contentText(block.content) || stringifyValue(block.content),
          timestamp,
          sourceType: record.type,
          sourceSubtype: block.type,
          toolName,
          toolKind: "tool_result",
          toolCallId,
          syntheticContext: syntheticRecord,
          isError: block.is_error === true,
          ...common
        });
        continue;
      }

      if (block.type === "thinking") {
        appendMessage(messages, {
          role: "assistant",
          text: contentText(block),
          timestamp,
          sourceType: record.type,
          sourceSubtype: block.type,
          syntheticContext: true,
          ...common
        });
        continue;
      }

      const text = contentText(block);
      if (text) {
        appendMessage(messages, {
          role,
          text,
          timestamp,
          sourceType: record.type,
          sourceSubtype: typeof block.type === "string" ? block.type : "content",
          syntheticContext: syntheticRecord,
          ...common
        });
      }
    }
    return messages;
  }

  if (record.type === "result") {
    const text = contentText(record.result) || contentText(record.error) || stringifyValue(record.result);
    appendMessage(messages, {
      role: "system",
      text,
      timestamp,
      sourceType: record.type,
      sourceSubtype: typeof record.subtype === "string" ? record.subtype : "result",
      isError: record.is_error === true || String(record.subtype || "").startsWith("error"),
      ...messageMetadata(record, null, forceSidechain)
    });
  } else if (record.type === "system" && (record.error || String(record.subtype || "").includes("error"))) {
    appendMessage(messages, {
      role: "system",
      text: contentText(record.error) || contentText(record.message) || stringifyValue(record.error),
      timestamp,
      sourceType: record.type,
      sourceSubtype: typeof record.subtype === "string" ? record.subtype : "error",
      isError: true,
      ...messageMetadata(record, null, forceSidechain)
    });
  }

  return messages;
}

function rawEventFromRecord(record, lineNumber) {
  const payload = { ...record };
  delete payload.type;
  delete payload.timestamp;
  return {
    line_number: lineNumber,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
    type: typeof record.type === "string" ? record.type : "unknown",
    payload
  };
}

function updateMetadata(metadata, record) {
  const message = record?.message && typeof record.message === "object" ? record.message : null;
  const stringFields = [
    ["sessionId", record.sessionId || record.session_id],
    ["cwd", record.cwd],
    ["entrypoint", record.entrypoint],
    ["version", record.version],
    ["gitBranch", record.gitBranch],
    ["slug", record.slug],
    ["agentId", record.agentId || record.agent_id],
    ["model", message?.model],
    ["provider", record.modelProvider || record.model_provider || record.provider || message?.provider]
  ];
  for (const [key, value] of stringFields) {
    if (!metadata[key] && typeof value === "string" && value) metadata[key] = value;
  }
  if (record.isSidechain === true) metadata.sawSidechain = true;
  if ((record.type === "user" || record.type === "assistant") && record.isSidechain !== true) {
    metadata.sawPrimaryConversation = true;
  }
}

function createSummary(filePath, metadata, firstTimestamp, lastTimestamp, eventCount) {
  const fallbackId = path.basename(filePath, path.extname(filePath));
  const isSubagentTranscript = metadata.forceSidechain === true;
  const parentSessionId = metadata.sessionId || "";
  const sessionId = isSubagentTranscript
    ? `${parentSessionId || "unknown"}:subagent:${metadata.agentId || fallbackId}`
    : parentSessionId || fallbackId;
  const summary = {
    id: sessionId,
    source_kind: "claude_code",
    display_source: "Claude Code",
    timestamp: firstTimestamp,
    model_provider: metadata.provider || "anthropic",
    cwd: metadata.cwd || "",
    source: isSubagentTranscript || (metadata.sawSidechain && !metadata.sawPrimaryConversation)
      ? "subagent"
      : metadata.entrypoint || "cli",
    originator: "claude_code",
    file_path: filePath,
    event_count: eventCount,
    last_timestamp: lastTimestamp || firstTimestamp || null
  };
  if (metadata.model) summary.model = metadata.model;
  if (metadata.version) summary.claude_code_version = metadata.version;
  if (metadata.gitBranch) summary.git_branch = metadata.gitBranch;
  if (metadata.slug) summary.slug = metadata.slug;
  if (isSubagentTranscript && parentSessionId) summary.parent_session_id = parentSessionId;
  if (isSubagentTranscript || (metadata.sawSidechain && !metadata.sawPrimaryConversation)) {
    summary.hidden = true;
    summary.hidden_reason = "subagent";
  }
  return summary;
}

function truncateMessage(message, maxTextChars) {
  if (message.text.length <= maxTextChars) return message;
  return {
    ...message,
    text: message.text.slice(0, maxTextChars),
    text_truncated: true,
    original_text_chars: message.text.length
  };
}

async function parseClaudeTranscript(filePath, options = {}) {
  const summaryOnly = options.summaryOnly === true;
  const maxConversationMessages = detailLimit(options.maxConversationMessages, DEFAULT_DETAIL_MAX_MESSAGES);
  const maxRawEvents = detailLimit(options.maxRawEvents, DEFAULT_DETAIL_MAX_RAW_EVENTS);
  const maxMessageTextChars = detailLimit(options.maxMessageTextChars, DEFAULT_DETAIL_MAX_MESSAGE_TEXT_CHARS);
  const maxRawEventLineChars = detailLimit(options.maxRawEventLineChars, DEFAULT_DETAIL_MAX_RAW_EVENT_LINE_CHARS);
  const maxConversationTextChars = Number.isFinite(options.maxConversationTextChars)
    ? Math.max(0, Math.floor(options.maxConversationTextChars))
    : DEFAULT_SUMMARY_TEXT_CHARS;
  const messageCollector = summaryOnly ? null : new HeadTailCollector(maxConversationMessages);
  const rawEventCollector = summaryOnly ? null : new HeadTailCollector(maxRawEvents);
  const summaryMessages = [];
  const accumulator = createConversationSummaryAccumulator();
  const toolCallNamesById = new Map();
  const metadata = {
    forceSidechain: path.normalize(filePath).split(path.sep).includes("subagents")
  };
  if (metadata.forceSidechain) metadata.sawSidechain = true;
  const input = fss.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  let remainingSummaryText = maxConversationTextChars;
  let firstTimestamp = null;
  let lastTimestamp = null;
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
      if (!summaryOnly) {
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
      }
      continue;
    }

    updateMetadata(metadata, record);
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
    if (timestamp && !firstTimestamp) firstTimestamp = timestamp;
    if (timestamp) lastTimestamp = timestamp;

    if (!summaryOnly) {
      const rawEvent = rawEventFromRecord(record, lineNumber);
      if (line.length > maxRawEventLineChars) {
        rawEvent.payload = {
          truncated: true,
          original_characters: line.length,
          record_type: rawEvent.type
        };
        truncatedRawEventCount += 1;
      }
      rawEventCollector.add(rawEvent);
    }

    const messages = conversationMessagesFromRecord(record, toolCallNamesById, {
      forceSidechain: metadata.forceSidechain
    });
    for (const message of messages) {
      addConversationMessageToSummary(accumulator, message);
      if (summaryOnly) {
        if (remainingSummaryText <= 0) continue;
        const text = message.text.slice(0, remainingSummaryText);
        if (text) summaryMessages.push({ ...message, text });
        remainingSummaryText = Math.max(0, remainingSummaryText - text.length);
      } else {
        const boundedMessage = truncateMessage(message, maxMessageTextChars);
        if (boundedMessage.text_truncated) truncatedMessageCount += 1;
        messageCollector.add(boundedMessage);
      }
    }
  }

  const summary = createSummary(filePath, metadata, firstTimestamp, lastTimestamp, eventCount);
  finalizeSessionSummaryFromAggregate(summary, accumulator);

  if (summaryOnly) {
    return { summary, raw_events: [], conversation_messages: summaryMessages };
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
  const detailTruncated = messages.omitted > 0 || rawEvents.omitted > 0 ||
    truncatedMessageCount > 0 || truncatedRawEventCount > 0;
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

async function parseClaudeLegacyFile(filePath) {
  const metaContent = await fs.readFile(filePath, "utf8");
  const meta = JSON.parse(metaContent);
  const sessionId = meta.sessionId || path.basename(filePath, ".json");
  const cwd = meta.cwd || "";
  const timestamp = msToIso(meta.startedAt);
  const historyPath = path.join(path.dirname(path.dirname(filePath)), "history.jsonl");
  const rawEvents = [{
    line_number: null,
    timestamp,
    type: "info",
    payload: { message: "Legacy Claude Code metadata; full project transcript is unavailable." }
  }];
  const conversationMessages = [];
  let lastTimestamp = timestamp;

  try {
    const historyContent = await fs.readFile(historyPath, "utf8");
    const lines = historyContent.split(/\r?\n/).filter((line) => line.trim());
    for (let index = 0; index < lines.length; index += 1) {
      let record;
      try {
        record = JSON.parse(lines[index]);
      } catch {
        rawEvents.push({
          line_number: index + 1,
          timestamp: null,
          type: "parse_error",
          payload: { message: "JSON parse error", raw_line: lines[index] }
        });
        continue;
      }
      if (record.sessionId !== sessionId) continue;
      const recordTimestamp = msToIso(record.timestamp);
      if (recordTimestamp) lastTimestamp = recordTimestamp;
      rawEvents.push({
        line_number: index + 1,
        timestamp: recordTimestamp,
        type: "user_input",
        payload: {
          display: record.display || "",
          project: record.project || "",
          pasted_contents: record.pastedContents || {}
        }
      });
      if (record.display) {
        pushConversationMessage(conversationMessages, {
          role: "user",
          text: record.display,
          timestamp: recordTimestamp,
          sourceType: "user_input",
          sourceSubtype: "display"
        });
      }
    }
  } catch (error) {
    if (error && typeof error === "object" && error.code !== "ENOENT") {
      console.error(`Claude Code history read error: ${error.message}`);
    }
  }

  const summary = {
    id: sessionId,
    source_kind: "claude_code",
    display_source: "Claude Code",
    timestamp,
    model_provider: "anthropic",
    cwd,
    source: meta.entrypoint || meta.kind || "",
    originator: "claude_code",
    file_path: filePath,
    event_count: rawEvents.length,
    last_timestamp: lastTimestamp || timestamp || null,
    legacy_format: true
  };
  finalizeSessionSummary(summary, conversationMessages);
  return { summary, raw_events: rawEvents, conversation_messages: conversationMessages };
}

export async function parseClaudeCodeFile(filePath, options = {}) {
  if (path.extname(filePath).toLowerCase() === ".json") {
    return parseClaudeLegacyFile(filePath);
  }
  return parseClaudeTranscript(filePath, options);
}

export async function parseClaudeCodeFileSummary(filePath, options = {}) {
  if (path.extname(filePath).toLowerCase() === ".json") {
    return parseClaudeLegacyFile(filePath);
  }
  return parseClaudeTranscript(filePath, { ...options, summaryOnly: true });
}
