import { displayMessageText } from "./session-export.js";

// 把工具调用与其结果合并为一个渲染单元；缺少 id、顺序颠倒或已被占用时保持独立。
export function groupToolMessages(messages) {
  const resultsById = new Map();
  messages.forEach((message, index) => {
    const id = message?.tool_call_id;
    if (
      message?.role !== "tool" ||
      !["tool_result", "function_call_output"].includes(message.tool_kind) ||
      !id
    )
      return;
    if (!resultsById.has(id)) resultsById.set(id, []);
    resultsById.get(id).push(index);
  });

  const consumed = new Set();
  const groups = [];
  messages.forEach((message, index) => {
    if (consumed.has(index)) return;
    const id = message?.tool_call_id;
    const resultIndex =
      message?.role === "tool" &&
      ["tool_call", "tool_use", "function_call"].includes(message.tool_kind) &&
      id
        ? resultsById.get(id)?.find((i) => i > index && !consumed.has(i))
        : undefined;
    if (resultIndex === undefined) {
      groups.push({ message, result: null });
      return;
    }
    consumed.add(resultIndex);
    groups.push({ message, result: messages[resultIndex] });
  });
  return groups;
}

export function roleCounts(messages) {
  const counts = new Map();
  for (const message of messages) {
    const role = String(message?.role || "").toLowerCase();
    if (role) counts.set(role, (counts.get(role) || 0) + 1);
  }
  return counts;
}

export function filterToolOperations(
  groups,
  { kind = "all", query = "" } = {}
) {
  const needle = query.trim().toLowerCase();
  return groups.filter(({ message, result }) => {
    if (message.role !== "tool") return false;
    if (kind === "commands" && !message.command_name) return false;
    if (kind === "files" && !message.file_activity?.length) return false;
    if (
      kind === "errors" &&
      message.is_error !== true &&
      result?.is_error !== true
    )
      return false;
    return (
      !needle ||
      [
        message.tool_name,
        message.command_name,
        ...(message.file_activity || []).map((activity) => activity.path),
        displayMessageText(message),
        result && displayMessageText(result),
      ]
        .filter(Boolean)
        .some((text) => text.toLowerCase().includes(needle))
    );
  });
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
