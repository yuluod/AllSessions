import { displayMessageText } from "./session-export.js";

export function roleCounts(messages) {
  const counts = new Map();
  for (const message of messages) {
    const role = String(message?.role || "").toLowerCase();
    if (role) counts.set(role, (counts.get(role) || 0) + 1);
  }
  return counts;
}

export function filterConversationMessages(messages, options = {}) {
  const query = String(options.query || "")
    .trim()
    .toLowerCase();
  return messages
    .map((message, index) => ({ ...message, _origIdx: index }))
    .filter((message) => options.showRemoved || message._removed !== true)
    .filter(
      (message) =>
        options.showTools ||
        message.role !== "tool" ||
        (Number.isInteger(options.searchTargetOrdinal) &&
          message.search_ordinal === options.searchTargetOrdinal)
    )
    .filter(
      (message) => options.showContext || message.synthetic_context !== true
    )
    .filter(
      (message) => !options.roleFilter || message.role === options.roleFilter
    )
    .filter(
      (message) =>
        !query || displayMessageText(message).toLowerCase().includes(query)
    );
}
