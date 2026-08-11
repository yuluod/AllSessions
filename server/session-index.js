export const MAX_INDEX_TEXT_CHARS = 64_000;
const SNIPPET_RADIUS = 72;
const WORD_CHAR_CLASS = "a-z0-9_.:-";

export function tokenizeSearchText(text) {
  const normalized = String(text || "").toLowerCase();
  return normalized.match(/[\p{Script=Han}]|[a-z0-9_.:-]{2,}/gu) || [];
}

function compactText(text, maxLength) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
}

function searchableSummaryText(summary) {
  return [
    summary.id,
    summary._key,
    summary.title,
    summary.preview_text,
    summary.cwd,
    summary.file_path,
    summary.source_kind,
    summary.display_source,
    summary.model_provider,
    summary.source,
    summary.originator
  ].filter(Boolean).join("\n");
}

function searchableMessageText(messages, maxLength) {
  const parts = [];
  let remaining = maxLength;

  const append = (value) => {
    if (remaining <= 0 || !value) return;
    const text = String(value);
    const chunk = text.length > remaining ? text.slice(0, remaining) : text;
    parts.push(chunk);
    remaining -= chunk.length;
  };

  for (const message of messages) {
    if (remaining <= 0) break;
    if (message.synthetic_context === true) continue;
    append([message.role, message.tool_name, message.tool_kind].filter(Boolean).join(" "));
    append(" ");
    append(message.text);
    append("\n");
  }

  return parts.join("");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenPattern(token) {
  if (/^\p{Script=Han}$/u.test(token)) {
    return new RegExp(escapeRegExp(token), "u");
  }
  return new RegExp(`(?:^|[^${WORD_CHAR_CLASS}])${escapeRegExp(token)}[${WORD_CHAR_CLASS}]*`, "iu");
}

function firstMatch(documentText, value, { token = false } = {}) {
  const pattern = token
    ? tokenPattern(value)
    : new RegExp(escapeRegExp(value), "iu");
  const match = pattern.exec(documentText);
  if (!match) return null;

  let index = match.index;
  if (token && !/^\p{Script=Han}$/u.test(value)) {
    const tokenOffset = match[0].toLowerCase().indexOf(String(value).toLowerCase());
    index += Math.max(0, tokenOffset);
  }
  return { index, length: String(value).length };
}

function createSnippet(documentText, query) {
  const queryText = String(query || "").trim();
  const exactMatch = queryText ? firstMatch(documentText, queryText) : null;
  if (exactMatch) {
    const { index, length } = exactMatch;
    const start = Math.max(0, index - SNIPPET_RADIUS);
    const end = Math.min(documentText.length, index + length + SNIPPET_RADIUS);
    const prefix = start > 0 ? "..." : "";
    const suffix = end < documentText.length ? "..." : "";
    return compactText(prefix + documentText.slice(start, end) + suffix, 180);
  }

  const tokens = tokenizeSearchText(queryText);
  const token = tokens.find(Boolean);
  if (!token) return "";
  const tokenMatch = firstMatch(documentText, token, { token: true });
  if (!tokenMatch) return "";
  const start = Math.max(0, tokenMatch.index - SNIPPET_RADIUS);
  const end = Math.min(documentText.length, tokenMatch.index + tokenMatch.length + SNIPPET_RADIUS);
  return compactText(
    `${start > 0 ? "..." : ""}${documentText.slice(start, end)}${end < documentText.length ? "..." : ""}`,
    180
  );
}

export class SessionSearchIndex {
  constructor() {
    this.documents = new Map();
  }

  clear() {
    this.documents.clear();
  }

  add(key, summary, messages) {
    const summaryText = searchableSummaryText(summary);
    const summaryPrefix = summaryText ? `${summaryText}\n` : "";
    const messageText = searchableMessageText(
      messages,
      Math.max(0, MAX_INDEX_TEXT_CHARS - summaryPrefix.length)
    );
    const text = `${summaryPrefix}${messageText}`.slice(0, MAX_INDEX_TEXT_CHARS);
    this.addText(key, text);
  }

  addText(key, text) {
    this.documents.set(key, { text: String(text || "").slice(0, MAX_INDEX_TEXT_CHARS) });
  }

  getText(key) {
    return this.documents.get(key)?.text || "";
  }

  delete(key) {
    this.documents.delete(key);
  }

  search(query) {
    const tokens = Array.from(new Set(tokenizeSearchText(query)));
    if (tokens.length === 0) return [];
    const patterns = tokens.map(tokenPattern);
    const results = [];

    for (const [key, document] of this.documents) {
      if (patterns.every((pattern) => pattern.test(document.text))) {
        results.push({
          key,
          snippet: createSnippet(document.text, query)
        });
      }
    }

    return results;
  }
}
