import { t } from "./i18n.js";
import { showDialogFromPopover } from "./ui-components.js";

const CREDENTIAL_PATTERNS = [
  ["exportCredentialOpenAI", /(?:\b|\\[nrt])sk-[A-Za-z0-9_-]{20,}/g],
  [
    "exportCredentialGitHub",
    /(?:\b|\\[nrt])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g,
  ],
  ["exportCredentialAws", /(?:\b|\\[nrt])(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  [
    "exportCredentialBearer",
    /(?:\b|\\[nrt])Bearer(?:[ \t]|\\t)+[A-Za-z0-9._~+/-]{12,}=*/gi,
  ],
  [
    "exportCredentialPrivateKey",
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  ],
];
const CREDENTIAL_LOCATION_LIMIT = 50;
const PAGE_SIZE = 16_384;
let previewActive = false;

export function credentialLocations(content) {
  const locations = [];
  let line = 0;
  let total = 0;
  for (const { 0: text, index: offset } of content.matchAll(
    /[^\r\n]*(?:\r\n?|\n|$)/g
  )) {
    line += 1;
    for (const [kind, pattern] of CREDENTIAL_PATTERNS) {
      let count = 0;
      let first;
      for (const match of text.matchAll(pattern)) {
        first ??= match;
        count += 1;
      }
      total += count;
      if (first && locations.length < CREDENTIAL_LOCATION_LIMIT) {
        const prefix = /^\\[nrt]/.test(first[0]) ? 2 : 0;
        const start = offset + first.index;
        locations.push({
          line,
          kind,
          count,
          start: start + prefix,
          end: start + first[0].length,
        });
      }
    }
  }
  return { locations, total };
}

export function previewRange(content, page) {
  // 同一对换行字符或 UTF-16 代理项保留在同一页。
  const boundary = (offset) => {
    const code = content.charCodeAt(offset);
    if (
      (code >= 0xdc00 && code <= 0xdfff) ||
      (content[offset] === "\n" && content[offset - 1] === "\r")
    ) {
      return offset - 1;
    }
    return Math.min(offset, content.length);
  };
  return {
    start: boundary(page * PAGE_SIZE),
    end: boundary((page + 1) * PAGE_SIZE),
    pages: Math.max(1, Math.ceil(content.length / PAGE_SIZE)),
  };
}

export function reviewSessionExport(build, redact) {
  const dialog = document.querySelector("#export-preview-dialog");
  if (previewActive) throw new Error(t("exportPreviewAlreadyOpen"));
  const form = dialog.querySelector("form");
  const filename = dialog.querySelector("#export-preview-filename");
  const toggle = dialog.querySelector("input");
  const warning = dialog.querySelector("#export-preview-warning");
  const hits = dialog.querySelector("#export-preview-hits");
  const remaining = dialog.querySelector("#export-preview-remaining");
  const output = dialog.querySelector("pre");
  const pageLabel = dialog.querySelector("#export-preview-page");
  const previous = dialog.querySelector("#export-preview-previous");
  const next = dialog.querySelector("#export-preview-next");
  const download = dialog.querySelector('button[value="download"]');
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  let file;
  let page = 0;

  function renderPage(hit) {
    const { content } = file;
    const { start, end, pages } = previewRange(content, page);
    output.scrollTop = 0;
    if (hit) {
      const highlight = document.createElement("mark");
      const matchEnd = Math.min(hit.end, end);
      highlight.textContent = content.slice(hit.start, matchEnd);
      output.replaceChildren(
        content.slice(start, hit.start),
        highlight,
        content.slice(matchEnd, end)
      );
      highlight.scrollIntoView({ block: "nearest" });
    } else {
      output.textContent = content.slice(start, end);
    }
    pageLabel.textContent = t("exportPreviewPage", { page: page + 1, pages });
    previous.disabled = page === 0;
    next.disabled = page + 1 >= pages;
  }

  function renderFile() {
    file = build(toggle.checked);
    filename.textContent = file.filename;
    const { locations, total } = credentialLocations(file.content);
    warning.closest("section").hidden = !total;
    warning.textContent = total
      ? t("exportCredentialWarning", { n: total })
      : "";
    hits.replaceChildren();
    let listed = 0;
    for (const hit of locations) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost-button";
      button.textContent = t("exportCredentialLocation", {
        line: hit.line,
        kind: t(hit.kind),
        count: hit.count,
      });
      button.onclick = () => {
        page = Math.floor(hit.start / PAGE_SIZE);
        renderPage(hit);
      };
      hits.append(button);
      listed += hit.count;
    }
    remaining.textContent =
      listed < total ? t("exportCredentialMore", { n: total - listed }) : "";
    download.textContent = t(
      total ? "exportCredentialContinue" : "exportPreviewDownload"
    );
    page = 0;
    renderPage();
  }

  return new Promise((resolve, reject) => {
    function clear() {
      listeners.abort();
      hits.replaceChildren();
      output.textContent = "";
      filename.textContent = "";
      file = null;
      previewActive = false;
    }
    previewActive = true;
    toggle.checked = redact;
    dialog.returnValue = "";
    try {
      renderFile();
      showDialogFromPopover(dialog);
    } catch (error) {
      clear();
      reject(error);
      return;
    }
    dialog.addEventListener(
      "close",
      () => {
        const result = dialog.returnValue === "download" ? file : null;
        clear();
        resolve(result);
      },
      { ...options, once: true }
    );
    form.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        dialog.close(event.submitter.value);
      },
      options
    );
    toggle.addEventListener(
      "change",
      () => {
        try {
          renderFile();
        } catch (error) {
          clear();
          dialog.close();
          reject(error);
        }
      },
      options
    );
    previous.addEventListener(
      "click",
      () => {
        page -= 1;
        renderPage();
      },
      options
    );
    next.addEventListener(
      "click",
      () => {
        page += 1;
        renderPage();
      },
      options
    );
  });
}
