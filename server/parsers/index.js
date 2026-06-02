import { parseCodexArchivedFile, parseCodexFile } from "./codex.js";
import { parseClaudeCodeFile } from "./claude-code.js";
import { parseGeminiSessions } from "./gemini.js";

const PARSERS = {
  codex: parseCodexFile,
  codex_archived: parseCodexArchivedFile,
  claude_code: parseClaudeCodeFile,
  gemini: null
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

export { parseGeminiSessions };
export { compareSummariesDesc } from "./common.js";
