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

const INTERNAL_FIELDS = new Set([
  "_delete_ref",
  "_message_key",
  "_removed",
  "_origIdx",
]);
const REDACTED_FIELDS = new Set([
  "_key",
  "id",
  "session_id",
  "sessionId",
  "parent_session_id",
  "agent_id",
  "cwd",
  "file_path",
]);

function redactText(value) {
  return value
    .replace(/(?:\/Users|\/home)\/[^\n\r\t"'`]+/g, "[local path]")
    .replace(/[A-Za-z]:\\[^\n\r\t"'`]+/g, "[local path]")
    .replace(/~\/[^\n\r\t"'`]+/g, "[local path]");
}

export function prepareExportDetail(detail, { redact = false } = {}) {
  return JSON.parse(
    JSON.stringify(detail, (key, value) => {
      if (INTERNAL_FIELDS.has(key)) return undefined;
      if (redact && REDACTED_FIELDS.has(key) && value) {
        return key === "cwd" || key === "file_path"
          ? "[local path]"
          : "[redacted]";
      }
      return redact && typeof value === "string" ? redactText(value) : value;
    })
  );
}

function exportFilename(detail, extension, redact) {
  const suffix = redact
    ? new Date().toISOString().replace(/[:.]/g, "-")
    : String(detail.summary.id).slice(0, 12);
  return `session-${suffix}.${extension}`;
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

function sessionMarkdown(detail) {
  const { summary, conversation_messages: messages = [] } = detail;
  const workspace = summary.workspace || {};
  const lines = [
    `# ${t("session")}: ${summary.cwd || summary.id}`,
    "",
    `- **${t("startTime")}**: ${formatTimestamp(summary.timestamp)}`,
    `- **Provider**: ${summary.model_provider || "unknown"}`,
    `- **${t("source")}**: ${summary.source || summary.originator || "-"}`,
    `- **${t("sessionId")}**: ${summary.id}`,
  ];
  if (workspace.favorite === true) {
    lines.push(`- **${t("favorite")}**: ✓`);
  }
  if (workspace.tags?.length) {
    lines.push(`- **${t("workspaceTags")}**: ${workspace.tags.join(", ")}`);
  }
  lines.push("");
  if (workspace.note) {
    lines.push(`## ${t("workspaceNote")}`, "", workspace.note, "");
  }
  messages.forEach((message) => {
    lines.push(`## ${message.role}`, "", displayMessageText(message), "");
  });
  return lines.join("\n");
}

export function exportSessionMarkdown(detail, options = {}) {
  const prepared = prepareExportDetail(detail, options);
  downloadBlob(
    sessionMarkdown(prepared),
    exportFilename(detail, "md", options.redact === true),
    "text/markdown; charset=utf-8"
  );
}

export function exportSessionJson(detail, options = {}) {
  downloadBlob(
    JSON.stringify(prepareExportDetail(detail, options), null, 2),
    exportFilename(detail, "json", options.redact === true),
    "application/json; charset=utf-8"
  );
}

export function exportSessionCollection(details, format, options = {}) {
  const prepared = details.map((detail) =>
    prepareExportDetail(detail, options)
  );
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "markdown") {
    downloadBlob(
      prepared.map(sessionMarkdown).join("\n\n---\n\n"),
      `allsessions-export-${stamp}.md`,
      "text/markdown; charset=utf-8"
    );
    return;
  }
  downloadBlob(
    JSON.stringify(
      { exported_at: new Date().toISOString(), sessions: prepared },
      null,
      2
    ),
    `allsessions-export-${stamp}.json`,
    "application/json; charset=utf-8"
  );
}
