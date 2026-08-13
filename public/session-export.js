import { t } from "./i18n.js";
import { formatTimestamp } from "./session-format.js";

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export function displayMessageText(message) {
  if (message.is_truncation_marker) {
    return t("detailMessagesOmitted", { n: message.omitted_count || 0 });
  }
  if (message.text_truncated) {
    return `${message.text}\n\n${t("detailMessageTextTruncated", { n: message.text.length })}`;
  }
  return message.text || "";
}

export function exportSessionMarkdown(detail) {
  const { summary, conversation_messages: messages } = detail;
  const lines = [
    `# ${t("session")}: ${summary.cwd || summary.id}`,
    "",
    `- **${t("startTime")}**: ${formatTimestamp(summary.timestamp)}`,
    `- **Provider**: ${summary.model_provider || "unknown"}`,
    `- **${t("source")}**: ${summary.source || summary.originator || "-"}`,
    `- **${t("sessionId")}**: ${summary.id}`,
    ""
  ];
  messages.forEach((message) => {
    lines.push(`## ${message.role}`, "", displayMessageText(message), "");
  });
  downloadBlob(
    lines.join("\n"),
    `session-${summary.id.slice(0, 12)}.md`,
    "text/markdown; charset=utf-8"
  );
}

export function exportSessionJson(detail) {
  downloadBlob(
    JSON.stringify(detail, null, 2),
    `session-${detail.summary.id.slice(0, 12)}.json`,
    "application/json; charset=utf-8"
  );
}
