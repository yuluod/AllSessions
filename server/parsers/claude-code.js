import fs from "node:fs/promises";
import path from "node:path";
import { pushConversationMessage } from "./common.js";

function msToIso(ms) {
  try {
    return new Date(Number(ms)).toISOString();
  } catch {
    return null;
  }
}

export async function parseClaudeCodeFile(filePath) {
  const metaContent = await fs.readFile(filePath, "utf8");
  const meta = JSON.parse(metaContent);

  const sessionId = meta.sessionId || path.basename(filePath, ".json");
  const cwd = meta.cwd || "";
  const startedAt = meta.startedAt || null;
  const timestamp = msToIso(startedAt);

  const historyPath = path.join(path.dirname(path.dirname(filePath)), "history.jsonl");
  const rawEvents = [];
  const conversationMessages = [];

  let lastTimestamp = timestamp;

  try {
    const historyContent = await fs.readFile(historyPath, "utf8");
    const lines = historyContent.split(/\r?\n/).filter((line) => line.trim());

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        rawEvents.push({
          line_number: i + 1,
          timestamp: null,
          type: "parse_error",
          payload: {
            message: "JSON parse error",
            raw_line: line
          }
        });
        continue;
      }

      if (record.sessionId !== sessionId) {
        continue;
      }

      const recordTimestamp = msToIso(record.timestamp);
      if (recordTimestamp) {
        lastTimestamp = recordTimestamp;
      }

      rawEvents.push({
        line_number: i + 1,
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
    last_timestamp: lastTimestamp || timestamp || null
  };

  return {
    summary,
    raw_events: rawEvents,
    conversation_messages: conversationMessages
  };
}
