import {
  parseCodexArchivedFile,
  parseCodexArchivedFileSummary,
  parseCodexFile,
  parseCodexFileSummary
} from "./codex.js";
import { parseClaudeCodeFile, parseClaudeCodeFileSummary } from "./claude-code.js";
import { parseGeminiSessions } from "./gemini.js";

const PARSERS = {
  codex: parseCodexFile,
  codex_archived: parseCodexArchivedFile,
  claude_code: parseClaudeCodeFile,
  gemini: null
};

const SUMMARY_PARSERS = {
  codex: parseCodexFileSummary,
  codex_archived: parseCodexArchivedFileSummary,
  claude_code: parseClaudeCodeFileSummary
};

export function getParser(sourceKind) {
  if (!(sourceKind in PARSERS)) return null;
  return PARSERS[sourceKind];
}

export async function parseFile(filePath, sourceKind) {
  if (sourceKind === "gemini") {
    throw new Error(
      "Gemini sessions span multiple sessions per file; use parseGeminiSessions() or parseGeminiSessionById() instead of parseFile()"
    );
  }
  const parser = getParser(sourceKind);
  if (!parser) {
    throw new Error(`Unknown source kind: ${sourceKind}`);
  }
  return parser(filePath);
}

export async function parseFileSummary(filePath, sourceKind) {
  const summaryParser = SUMMARY_PARSERS[sourceKind];
  if (summaryParser) return summaryParser(filePath);
  return parseFile(filePath, sourceKind);
}

export { parseGeminiSessions };
export { compareSummariesDesc, sortTimestampValue } from "./common.js";
