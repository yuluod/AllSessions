import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function buildSession(sessionId, entries, queueDirs, rootDir) {
  entries.sort((a, b) => (a.messageId ?? 0) - (b.messageId ?? 0));

  const rawEvents = [];
  const conversationMessages = [];

  for (const entry of entries) {
    const timestamp = entry.timestamp || null;
    if (entry.type === "user" && entry.message) {
      rawEvents.push({
        line_number: entry.messageId ?? null,
        timestamp,
        type: "user_input",
        payload: {
          message: entry.message,
          queueDir: [...queueDirs].join(",")
        }
      });
      conversationMessages.push({
        role: "user",
        text: entry.message.trim(),
        timestamp,
        source_type: "user_input",
        source_subtype: null
      });
    }
  }

  const timestamps = entries
    .map((e) => e.timestamp)
    .filter(Boolean)
    .sort();

  const firstQueueDir = [...queueDirs][0] || "";
  const summary = {
    id: sessionId,
    source_kind: "gemini",
    display_source: "Gemini CLI",
    timestamp: timestamps[0] || null,
    model_provider: "google",
    cwd: os.homedir(),
    source: "cli",
    originator: "google_gemini",
    file_path: path.join(rootDir, "tmp", firstQueueDir, "logs.json"),
    event_count: rawEvents.length,
    last_timestamp: timestamps[timestamps.length - 1] || null
  };

  return { summary, raw_events: rawEvents, conversation_messages: conversationMessages };
}

async function enrichWithBrain(rootDir, sessionId, result) {
  const brainDir = path.join(rootDir, "antigravity", "brain", sessionId);
  let brainFiles = [];
  try {
    brainFiles = await fs.readdir(brainDir, { withFileTypes: true });
  } catch {
    return;
  }

  const artifactFiles = brainFiles
    .filter((f) => f.isFile())
    .map((f) => f.name)
    .filter((name) => !name.endsWith(".metadata.json") && !name.endsWith(".resolved"))
    .filter((name) => !name.toLowerCase().startsWith("uploaded_"));

  for (const artifactName of artifactFiles) {
    const resolvedPath = path.join(brainDir, artifactName + ".resolved");
    const metadataPath = path.join(brainDir, artifactName + ".metadata.json");

    try {
      const promptText = await fs.readFile(path.join(brainDir, artifactName), "utf8");
      if (promptText.trim()) {
        const alreadyHas = result.conversation_messages.some(
          (m) => m.role === "user" && m.text.includes(promptText.trim().slice(0, 80))
        );
        if (!alreadyHas) {
          let promptTimestamp = null;
          try {
            const metaRaw = await fs.readFile(metadataPath, "utf8");
            const meta = JSON.parse(metaRaw);
            promptTimestamp = meta.updatedAt || null;
          } catch {
            // ignore
          }
          result.conversation_messages.push({
            role: "user",
            text: promptText.trim(),
            timestamp: promptTimestamp,
            source_type: "artifact",
            source_subtype: artifactName
          });
        }
      }
    } catch {
      // ignore
    }

    const resolvedTexts = [];
    try {
      const text = await fs.readFile(resolvedPath, "utf8");
      if (text.trim()) resolvedTexts.push(text.trim());
    } catch {
      // no main resolved
    }

    let idx = 0;
    while (true) {
      try {
        const text = await fs.readFile(resolvedPath + "." + idx, "utf8");
        if (text.trim()) resolvedTexts.push(text.trim());
        idx++;
      } catch {
        break;
      }
    }

    for (const rt of resolvedTexts) {
      result.conversation_messages.push({
        role: "assistant",
        text: rt,
        timestamp: null,
        source_type: "resolved",
        source_subtype: artifactName
      });
    }
  }
}

export async function parseGeminiSessions(rootDir) {
  const tmpDir = path.join(rootDir, "tmp");
  let tmpEntries;
  try {
    tmpEntries = await fs.readdir(tmpDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const allSessions = new Map();

  for (const entry of tmpEntries) {
    if (!entry.isDirectory()) continue;
    const logsPath = path.join(tmpDir, entry.name, "logs.json");
    let logs;
    try {
      const raw = await fs.readFile(logsPath, "utf8");
      logs = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(logs)) continue;

    for (const item of logs) {
      const sid = item.sessionId;
      if (!sid) continue;
      if (!allSessions.has(sid)) {
        allSessions.set(sid, { entries: [], queueDirs: new Set() });
      }
      const session = allSessions.get(sid);
      session.entries.push(item);
      session.queueDirs.add(entry.name);
    }
  }

  const results = [];

  for (const [sessionId, session] of allSessions) {
    const result = buildSession(sessionId, session.entries, session.queueDirs, rootDir);
    await enrichWithBrain(rootDir, sessionId, result);
    if (result.conversation_messages.length > 0) {
      results.push(result);
    }
  }

  return results;
}

export async function parseGeminiSessionById(rootDir, sessionId) {
  const tmpDir = path.join(rootDir, "tmp");
  let tmpEntries;
  try {
    tmpEntries = await fs.readdir(tmpDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const entries = [];
  const queueDirs = new Set();

  for (const entry of tmpEntries) {
    if (!entry.isDirectory()) continue;
    const logsPath = path.join(tmpDir, entry.name, "logs.json");
    let logs;
    try {
      const raw = await fs.readFile(logsPath, "utf8");
      logs = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(logs)) continue;

    for (const item of logs) {
      if (item.sessionId === sessionId) {
        entries.push(item);
        queueDirs.add(entry.name);
      }
    }
  }

  if (entries.length === 0) return null;

  const result = buildSession(sessionId, entries, queueDirs, rootDir);
  await enrichWithBrain(rootDir, sessionId, result);

  if (result.conversation_messages.length === 0) return null;
  return result;
}
