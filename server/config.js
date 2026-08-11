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

const codexDir = resolveDir("CODEX_SESSIONS_DIR", path.join(os.homedir(), ".codex", "sessions"));
const codexArchivedDir = resolveDir("CODEX_ARCHIVED_SESSIONS_DIR", path.join(os.homedir(), ".codex", "archived_sessions"));
const claudeDir = resolveDir("CLAUDE_SESSIONS_DIR", path.join(os.homedir(), ".claude"));
const geminiDir = resolveDir("GEMINI_SESSIONS_DIR", path.join(os.homedir(), ".gemini"));
const claudeSessionsDir = claudeDir ? path.join(claudeDir, "sessions") : null;
const geminiTmpDir = geminiDir ? path.join(geminiDir, "tmp") : null;

function defaultCacheDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "AllSessions");
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "AllSessions", "Cache");
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "allsessions");
}

export const SOURCES = [
  {
    kind: "codex",
    displayName: "Codex",
    rootDir: codexDir,
    filePattern: "**/*.jsonl",
    matchFn: (filePath) => filePath.endsWith(".jsonl")
  },
  {
    kind: "codex_archived",
    displayName: "Codex Archived",
    rootDir: codexArchivedDir,
    filePattern: "**/*.jsonl",
    matchFn: (filePath) => filePath.endsWith(".jsonl")
  },
  {
    kind: "claude_code",
    displayName: "Claude Code",
    rootDir: claudeDir,
    discoveryRoots: [claudeSessionsDir],
    watchRoots: [claudeSessionsDir],
    filePattern: "sessions/*.json",
    matchFn: (filePath) => {
      const filename = path.basename(filePath);
      return filePath.endsWith(".json") &&
        filePath.includes(path.sep + "sessions" + path.sep + filename);
    }
  },
  {
    kind: "gemini",
    displayName: "Gemini CLI",
    rootDir: geminiDir,
    watchRoots: [geminiTmpDir],
    filePattern: "tmp/*/logs.json",
    matchFn: (filePath) => {
      if (!geminiDir) return false;
      const relativeParts = path.relative(geminiDir, filePath).split(path.sep);
      return relativeParts.length === 3 && relativeParts[0] === "tmp" && relativeParts[2] === "logs.json";
    }
  }
].filter((s) => dirExists(s.rootDir));

export const HOST = process.env.HOST || "127.0.0.1";
export const PORT = Number(process.env.PORT || "3210");
export const INDEX_CACHE_FILE = process.env.SESSION_VIEWER_DISABLE_CACHE === "1"
  ? null
  : path.join(path.resolve(process.env.SESSION_VIEWER_CACHE_DIR || defaultCacheDir()), "session-index.json");
