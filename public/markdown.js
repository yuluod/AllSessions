function safeLinkHref(value) {
  const href = String(value || "").trim();
  if (/^(?:https?:|mailto:)/i.test(href) || href.startsWith("#")) {
    return href;
  }
  return "";
}

function firstInlineMatch(text) {
  const patterns = [
    { kind: "code", regex: /`([^`\n]+)`/ },
    { kind: "image", regex: /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/ },
    { kind: "link", regex: /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/ },
    { kind: "strong", regex: /\*\*([^*\n]+)\*\*/ },
    { kind: "strike", regex: /~~([^~\n]+)~~/ },
    { kind: "em", regex: /\*([^*\n]+)\*/ },
    { kind: "url", regex: /https?:\/\/[^\s<>]+/i }
  ];
  let selected = null;
  for (const pattern of patterns) {
    const match = pattern.regex.exec(text);
    if (!match) continue;
    if (!selected || match.index < selected.match.index) {
      selected = { ...pattern, match };
    }
  }
  return selected;
}

function trimUrlPunctuation(value) {
  return String(value).replace(/[),.;!?]+$/, "");
}

function appendInline(parent, value, depth = 0) {
  let remaining = String(value || "");
  if (depth > 8) {
    parent.append(document.createTextNode(remaining));
    return;
  }

  while (remaining) {
    const selected = firstInlineMatch(remaining);
    if (!selected) {
      parent.append(document.createTextNode(remaining));
      return;
    }
    const { kind, match } = selected;
    if (match.index > 0) {
      parent.append(document.createTextNode(remaining.slice(0, match.index)));
    }

    let node;
    if (kind === "code") {
      node = document.createElement("code");
      node.textContent = match[1];
    } else if (kind === "image") {
      node = document.createElement("span");
      node.className = "markdown-image-label";
      node.textContent = match[1] ? `🖼 ${match[1]}` : "🖼 image";
    } else if (kind === "link") {
      const href = safeLinkHref(match[2]);
      if (href) {
        node = document.createElement("a");
        node.href = href;
        node.target = "_blank";
        node.rel = "noopener noreferrer";
        appendInline(node, match[1], depth + 1);
      } else {
        node = document.createDocumentFragment();
        appendInline(node, match[1], depth + 1);
      }
    } else if (kind === "strong") {
      node = document.createElement("strong");
      appendInline(node, match[1], depth + 1);
    } else if (kind === "strike") {
      node = document.createElement("del");
      appendInline(node, match[1], depth + 1);
    } else if (kind === "em") {
      node = document.createElement("em");
      appendInline(node, match[1], depth + 1);
    } else {
      const url = trimUrlPunctuation(match[0]);
      node = document.createElement("a");
      node.href = url;
      node.target = "_blank";
      node.rel = "noopener noreferrer";
      node.textContent = url;
    }
    parent.append(node);
    const consumedLength = kind === "url" ? trimUrlPunctuation(match[0]).length : match[0].length;
    remaining = remaining.slice(match.index + consumedLength);
  }
}

function appendInlineLines(parent, lines) {
  lines.forEach((line, index) => {
    if (index > 0) parent.append(document.createElement("br"));
    appendInline(parent, line);
  });
}

function isFence(line) {
  return /^\s*(```|~~~)/.test(line);
}

function isListItem(line) {
  return /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
}

function isTableDelimiter(line) {
  const cells = String(line).trim().replace(/^\||\|$/g, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function tableCells(line) {
  return String(line).trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function isBlockStart(lines, index) {
  const line = lines[index] || "";
  if (!line.trim()) return true;
  if (isFence(line) || /^\s{0,3}#{1,6}\s+/.test(line)) return true;
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return true;
  if (/^\s*>\s?/.test(line) || isListItem(line)) return true;
  return index + 1 < lines.length && line.includes("|") && isTableDelimiter(lines[index + 1]);
}

function appendTable(parent, headerLine, delimiterLine, bodyLines) {
  const headers = tableCells(headerLine);
  const alignments = tableCells(delimiterLine).map((cell) => {
    if (/^:-+:$/.test(cell)) return "center";
    if (/-+:$/.test(cell)) return "right";
    return "left";
  });
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headers.forEach((value, index) => {
    const th = document.createElement("th");
    th.style.textAlign = alignments[index] || "left";
    appendInline(th, value);
    headerRow.append(th);
  });
  thead.append(headerRow);
  table.append(thead);

  if (bodyLines.length > 0) {
    const tbody = document.createElement("tbody");
    bodyLines.forEach((line) => {
      const row = document.createElement("tr");
      const cells = tableCells(line);
      headers.forEach((_, index) => {
        const td = document.createElement("td");
        td.style.textAlign = alignments[index] || "left";
        appendInline(td, cells[index] || "");
        row.append(td);
      });
      tbody.append(row);
    });
    table.append(tbody);
  }
  parent.append(table);
}

export function renderMarkdown(container, markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const fragment = document.createDocumentFragment();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^\s*(```|~~~)\s*([^\s]*)\s*$/.exec(line);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[2]) code.className = `language-${fence[2].replace(/[^a-z0-9_-]/gi, "")}`;
      code.textContent = codeLines.join("\n");
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      appendInline(element, heading[2]);
      fragment.append(element);
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      fragment.append(document.createElement("hr"));
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && line.includes("|") && isTableDelimiter(lines[index + 1])) {
      const bodyLines = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trim() && lines[cursor].includes("|")) {
        bodyLines.push(lines[cursor]);
        cursor += 1;
      }
      appendTable(fragment, line, lines[index + 1], bodyLines);
      index = cursor;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      const blockquote = document.createElement("blockquote");
      renderMarkdown(blockquote, quoteLines.join("\n"));
      fragment.append(blockquote);
      continue;
    }

    if (isListItem(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (index < lines.length && isListItem(lines[index])) {
        const currentOrdered = /^\s*\d+[.)]\s+/.test(lines[index]);
        if (currentOrdered !== ordered) break;
        const item = document.createElement("li");
        appendInline(item, lines[index].replace(/^\s*(?:[-+*]|\d+[.)])\s+/, ""));
        list.append(item);
        index += 1;
      }
      fragment.append(list);
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    if (paragraphLines.length === 0) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = document.createElement("p");
    appendInlineLines(paragraph, paragraphLines);
    fragment.append(paragraph);
  }

  container.replaceChildren(fragment);
}

export function markdownToPlainText(markdown) {
  return String(markdown || "")
    .replace(/^\s*(```|~~~)[^\n]*$/gm, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, " ")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, " ")
    .replace(/(`+|\*\*|~~)/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
