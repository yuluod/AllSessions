import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveDir(envVar, fallback) {
  const value = process.env[envVar];
  if (value) return path.resolve(value);
  try {
    return path.resolve(fallback);
  } catch {
    return null;
  }
}

function dirExists(dir) {
  if (!dir) return false;
  try {
    const stats = fs.statSync(dir);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

export const SOURCES = [
  {
    kind: "codex",
    displayName: "Codex",
    rootDir: resolveDir("CODEX_SESSIONS_DIR", path.join(os.homedir(), ".codex", "sessions")),
    filePattern: "**/*.jsonl"
  },
  {
    kind: "claude_code",
    displayName: "Claude Code",
    rootDir: resolveDir("CLAUDE_SESSIONS_DIR", path.join(os.homedir(), ".claude")),
    filePattern: "sessions/*.json"
  },
  {
    kind: "gemini",
    displayName: "Gemini CLI",
    rootDir: resolveDir("GEMINI_SESSIONS_DIR", path.join(os.homedir(), ".gemini")),
    filePattern: "tmp/*/logs.json"
  }
].filter((s) => dirExists(s.rootDir));

export const HOST = process.env.HOST || "127.0.0.1";
export const PORT = Number.parseInt(process.env.PORT || "3210", 10);
