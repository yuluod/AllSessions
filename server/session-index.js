const MAX_INDEX_TEXT_CHARS = 500_000;
const SNIPPET_RADIUS = 72;

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

function searchableMessageText(messages) {
  return messages
    .map((message) => [
      message.role,
      message.tool_name,
      message.tool_kind,
      message.text
    ].filter(Boolean).join(" "))
    .join("\n");
}

function createSnippet(document, query) {
  const queryText = String(query || "").trim();
  const queryLower = queryText.toLowerCase();
  const fields = document.snippetFields;
  const exact = fields.find((field) => field.toLowerCase().includes(queryLower));
  if (exact && queryLower) {
    const lower = exact.toLowerCase();
    const index = lower.indexOf(queryLower);
    const start = Math.max(0, index - SNIPPET_RADIUS);
    const end = Math.min(exact.length, index + queryText.length + SNIPPET_RADIUS);
    const prefix = start > 0 ? "..." : "";
    const suffix = end < exact.length ? "..." : "";
    return compactText(prefix + exact.slice(start, end) + suffix, 180);
  }

  const tokens = tokenizeSearchText(queryText);
  const token = tokens.find(Boolean);
  if (!token) return "";
  const tokenMatch = fields.find((field) => tokenizeSearchText(field).includes(token));
  return tokenMatch ? compactText(tokenMatch, 180) : "";
}

export class SessionSearchIndex {
  constructor() {
    this.index = new Map();
    this.documents = new Map();
  }

  clear() {
    this.index.clear();
    this.documents.clear();
  }

  add(key, summary, messages) {
    const summaryText = searchableSummaryText(summary);
    const messageText = searchableMessageText(messages);
    const text = [summaryText, messageText].filter(Boolean).join("\n").slice(0, MAX_INDEX_TEXT_CHARS);
    const tokens = new Set(tokenizeSearchText(text));

    this.documents.set(key, {
      text,
      tokens,
      snippetFields: [
        summary.title,
        summary.preview_text,
        summary.cwd,
        summary.file_path,
        summary.model_provider,
        summary.source_kind,
        ...messages.map((message) => message.text)
      ].filter(Boolean)
    });

    for (const token of tokens) {
      if (!this.index.has(token)) {
        this.index.set(token, new Set());
      }
      this.index.get(token).add(key);
    }
  }

  delete(key) {
    const document = this.documents.get(key);
    if (!document) return;
    for (const token of document.tokens) {
      const keys = this.index.get(token);
      if (!keys) continue;
      keys.delete(key);
      if (keys.size === 0) {
        this.index.delete(token);
      }
    }
    this.documents.delete(key);
  }

  search(query) {
    const tokens = tokenizeSearchText(query);
    if (tokens.length === 0) return [];

    const resultSets = tokens.map((token) => {
      const matched = new Set();
      const exact = this.index.get(token);
      if (exact) {
        for (const key of exact) matched.add(key);
      }
      if (!/^\p{Script=Han}$/u.test(token)) {
        for (const [indexWord, keys] of this.index) {
          if (indexWord !== token && indexWord.startsWith(token)) {
            for (const key of keys) matched.add(key);
          }
        }
      }
      return matched;
    });

    let intersection = resultSets[0];
    for (let i = 1; i < resultSets.length; i++) {
      intersection = new Set([...intersection].filter((key) => resultSets[i].has(key)));
    }

    return [...intersection].map((key) => ({
      key,
      snippet: createSnippet(this.documents.get(key), query)
    }));
  }
}
