import { t } from "./i18n.js";
import { regexMatchRanges } from "./search-highlight.js";

export function searchPattern(query) {
  const source = String(query).trim();
  if (!source) return null;
  const terms = [...new Set(source.split(/\s+/).filter(Boolean))];
  return new RegExp(
    terms
      .sort((a, b) => b.length - a.length)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "giu"
  );
}

function textNodes(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function highlightRanges(node, ranges) {
  if (!ranges.length) return;
  const text = node.textContent;
  const fragment = document.createDocumentFragment();
  let offset = 0;
  for (const [start, end] of ranges) {
    fragment.append(document.createTextNode(text.slice(offset, start)));
    const mark = document.createElement("mark");
    mark.className = "search-highlight";
    mark.textContent = text.slice(start, end);
    fragment.append(mark);
    offset = end;
  }
  fragment.append(document.createTextNode(text.slice(offset)));
  node.replaceWith(fragment);
}

export function highlightMatches(container, query) {
  const pattern = searchPattern(query);
  if (!pattern) return;
  for (const node of textNodes(container)) {
    const ranges = [...node.textContent.matchAll(pattern)].map((match) => [
      match.index,
      match.index + match[0].length,
    ]);
    highlightRanges(node, ranges);
  }
}

export async function highlightRegexMatches(containers, query, options) {
  if (!String(query).trim()) return;
  const nodes = [...containers].flatMap(textNodes);
  if (!nodes.length) return;
  const texts = nodes.map((node) => node.textContent);
  const ranges = await regexMatchRanges(texts, query, options);
  if (options?.signal?.aborted) return;
  nodes.forEach((node, index) => {
    // 异步返回时只更新仍在页面中且正文未被重绘的节点。
    if (node.isConnected && node.textContent === texts[index]) {
      highlightRanges(node, ranges[index]);
    }
  });
}

export function bindMatchNavigation(container) {
  const marks = [...container.querySelectorAll("mark.search-highlight")];
  const count = document.querySelector("#detail-search-count");
  const previous = document.querySelector("#search-previous");
  const next = document.querySelector("#search-next");
  let index = -1;
  if (count)
    count.textContent = marks.length
      ? t("searchMatches", { n: marks.length })
      : "";
  const move = (direction) => {
    marks[index]?.classList.remove("current-match");
    index =
      index < 0
        ? direction > 0
          ? 0
          : marks.length - 1
        : (index + direction + marks.length) % marks.length;
    const mark = marks[index];
    mark.classList.add("current-match");
    const card = mark.closest(".message-card");
    if (card?.classList.contains("collapsed"))
      card.querySelector(".message-toggle")?.click();
    mark.scrollIntoView({ block: "center" });
    if (count) count.textContent = `${index + 1} / ${marks.length}`;
  };
  if (previous) {
    previous.disabled = !marks.length;
    previous.onclick = () => move(-1);
  }
  if (next) {
    next.disabled = !marks.length;
    next.onclick = () => move(1);
  }
}
