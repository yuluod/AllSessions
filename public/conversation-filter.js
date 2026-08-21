import { displayMessageText } from "./session-export.js";

export function filterConversationMessages(messages, options = {}) {
  const query = String(options.query || "")
    .trim()
    .toLowerCase();
  return messages
    .map((message, index) => ({ ...message, _origIdx: index }))
    .filter((message) => options.showRemoved || message._removed !== true)
    .filter((message) => options.showTools || message.role !== "tool")
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
