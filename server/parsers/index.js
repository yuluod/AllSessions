import { parseCodexFile } from "./codex.js";
import { parseClaudeCodeFile } from "./claude-code.js";

const PARSERS = {
  codex: parseCodexFile,
  claude_code: parseClaudeCodeFile
};

export function getParser(sourceKind) {
  return PARSERS[sourceKind] || null;
}

export async function parseFile(filePath, sourceKind) {
  const parser = getParser(sourceKind);
  if (!parser) {
    throw new Error(`Unknown source kind: ${sourceKind}`);
  }
  return parser(filePath);
}

export { compareSummariesDesc } from "./common.js";
