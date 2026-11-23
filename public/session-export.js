import { reviewSessionExport } from "./export-preview.js";
import { fetchJson } from "./api-client.js";
import { t } from "./i18n.js";
import { formatTimestamp, providerLabel } from "./session-format.js";

export function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function downloadSessionFile(details, build, redact) {
  const rules = await fetchJson("/api/settings/export-redaction");
  const prepared = details.map((detail) => prepareExportDetail(detail));
  const document = rules.enabled
    ? await fetchJson("/api/export/redact", {
        method: "POST",
        body: { rules, document: prepared },
      })
    : prepared;
  const file = await reviewSessionExport(
    (hidePaths) =>
      build(
        hidePaths
          ? document.map((detail) => cleanExportDetail(detail, true))
          : document,
        hidePaths || rules.enabled
      ),
    redact,
    rules.enabled
  );
  if (file) downloadBlob(file.content, file.filename, file.type);
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

// 带 scheme 的 URL 其 path 不是本地路径，先整体占位保护、脱敏后原样还原；
// file: 除外，其中的路径仍需脱敏。
const URL_PATTERN = /\b(?!file:)[a-z][a-z\d+.-]*:\/\/[^\n\r\s"'`]+/gi;
// \\?\ 扩展长度路径与 UNC（\\主机\共享\…）；需先于盘符规则，避免留下 \\?\ 残段。
const UNC_EXTENDED_PATTERN = /\\\\\?\\[^\n\r\t"'`]+/g;
const UNC_PATTERN = /\\\\[^\s"'`\\]+(?:\\[^\n\r\t"'`\\]+)+/g;
// 多段 Unix 绝对路径兜底（含 //server/share 形式）；单段只认常见系统根目录，
// 避免把「输入/输出」「cmd /c」这类正文与命令开关误当路径。
// 不用 lookbehind：旧版 WebKit（macOS 13.2 及更早）不支持，会导致模块加载失败。
const POSIX_ABSOLUTE_PATTERN =
  /(^|[^\w.])(\/{1,2}(?=[^\s"'`]*\/)[^\n\r\t"'`]+)/g;
const POSIX_BARE_ROOT_PATTERN =
  /\/(?:applications|bin|boot|data|dev|etc|home|lib|lib64|library|media|mnt|opt|private|proc|root|run|sbin|srv|sys|tmp|users|usr|var|volumes)(?![\w./\\-])/gi;

export function redactText(value) {
  const urls = [];
  return value
    .replace(URL_PATTERN, (url) => {
      urls.push(url);
      return `\uE000${urls.length - 1}\uE000`;
    })
    .replace(/(?:\/Users|\/home)\/[^\n\r\t"'`]+/g, "[local path]")
    .replace(UNC_EXTENDED_PATTERN, "[local path]")
    .replace(UNC_PATTERN, "[local path]")
    .replace(/[A-Za-z]:\\[^\n\r\t"'`]+/g, "[local path]")
    .replace(/~\/[^\n\r\t"'`]+/g, "[local path]")
    .replace(POSIX_ABSOLUTE_PATTERN, (_, prefix) => `${prefix}[local path]`)
    .replace(POSIX_BARE_ROOT_PATTERN, "[local path]")
    .replace(/\uE000(\d+)\uE000/g, (_, index) => urls[Number(index)]);
}

export function prepareExportDetail(detail, { redact = false } = {}) {
  const messages = detail.conversation_messages || [];
  const loaded = messages.filter((message) => !message.is_truncation_marker);
  const partial = Boolean(
    detail.search_context ||
    detail.summary?.detail_truncated ||
    detail.truncation?.truncated ||
    detail.raw_events?.some((event) => event.payload?.truncated === true) ||
    messages.some(
      (message) => message.is_truncation_marker || message.text_truncated
    )
  );
  // 后端全量导出已给出权威完整性口径，概览导出才按已加载内容推算。
  const exportInfo =
    detail.export_info?.scope === "full_session"
      ? { ...detail.export_info }
      : {
          scope: "loaded_content",
          partial,
          message_count: loaded.length,
          total_messages: detail.search_context
            ? null
            : (detail.truncation?.messages?.total ??
              (partial ? null : loaded.length)),
          text_truncated: loaded.some(
            (message) => message.text_truncated === true
          ),
        };
  return cleanExportDetail({ ...detail, export_info: exportInfo }, redact);
}

function cleanExportDetail(detail, redact) {
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

function exportFilename(detail, extension, redact, full, timestamp) {
  const suffix = redact
    ? timestamp.replace(/[:.]/g, "-")
    : String(detail.summary.id).slice(0, 12);
  return `session-${full ? "full-" : ""}${suffix}.${extension}`;
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

export function sessionMarkdown(detail) {
  const { summary, conversation_messages: messages = [] } = detail;
  const workspace = summary.workspace || {};
  const lines = [
    `# ${t("session")}: ${summary.cwd || summary.id}`,
    "",
    `- **${t("startTime")}**: ${formatTimestamp(summary.timestamp)}`,
    `- **Provider**: ${providerLabel(summary)}`,
    `- **${t("source")}**: ${summary.source || summary.originator || "-"}`,
    `- **${t("sessionId")}**: ${summary.id}`,
  ];
  if (detail.export_info) {
    const info = detail.export_info;
    const noticeKey =
      info.scope === "full_session"
        ? info.partial
          ? "exportFullPartialNotice"
          : "exportFullNotice"
        : info.partial
          ? "exportPartialNotice"
          : "exportLoadedNotice";
    lines.push("", `> ${t(noticeKey, { n: info.message_count })}`);
  }
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

function exportSingleSession(detail, format, options) {
  const markdown = format === "markdown";
  const stamp = new Date().toISOString();
  return downloadSessionFile(
    [detail],
    ([prepared], anonymousFilename) => {
      return {
        content: markdown
          ? sessionMarkdown(prepared)
          : JSON.stringify(prepared, null, 2),
        filename: exportFilename(
          detail,
          markdown ? "md" : "json",
          anonymousFilename,
          options.full === true,
          stamp
        ),
        type: markdown
          ? "text/markdown; charset=utf-8"
          : "application/json; charset=utf-8",
      };
    },
    options.redact === true
  );
}

export function exportSessionMarkdown(detail, options = {}) {
  return exportSingleSession(detail, "markdown", options);
}

export function exportSessionJson(detail, options = {}) {
  return exportSingleSession(detail, "json", options);
}

export function exportSessionCollection(details, format, options = {}) {
  const stamp = new Date().toISOString();
  const markdown = format === "markdown";
  return downloadSessionFile(
    details,
    (prepared) => {
      return {
        content: markdown
          ? prepared.map(sessionMarkdown).join("\n\n---\n\n")
          : JSON.stringify({ exported_at: stamp, sessions: prepared }, null, 2),
        filename: `allsessions-export-${stamp.slice(0, 10)}.${markdown ? "md" : "json"}`,
        type: markdown
          ? "text/markdown; charset=utf-8"
          : "application/json; charset=utf-8",
      };
    },
    options.redact === true
  );
}
