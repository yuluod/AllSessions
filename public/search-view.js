import { t } from "./i18n.js";

export function searchPattern(query) {
  const terms = [...new Set(String(query).trim().split(/\s+/).filter(Boolean))];
  if (!terms.length) return null;
  return new RegExp(
    terms
      .sort((a, b) => b.length - a.length)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "giu"
  );
}

export function highlightMatches(container, query) {
  const pattern = searchPattern(query);
  if (!pattern) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of node.textContent.matchAll(pattern)) {
      fragment.append(
        document.createTextNode(node.textContent.slice(offset, match.index))
      );
      const mark = document.createElement("mark");
      mark.className = "search-highlight";
      mark.textContent = match[0];
      fragment.append(mark);
      offset = match.index + match[0].length;
    }
    if (offset) {
      fragment.append(document.createTextNode(node.textContent.slice(offset)));
      node.replaceWith(fragment);
    }
  }
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
