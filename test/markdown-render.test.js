import assert from "node:assert/strict";
import test from "node:test";

import { renderMarkdown } from "../public/markdown.js";

class TestNode {
  constructor(type, value = "") {
    this.type = type;
    this.value = value;
    this.children = [];
    this.className = "";
    this.style = {};
  }

  append(...nodes) {
    nodes.forEach((node) => {
      if (node.type === "fragment") this.children.push(...node.children);
      else this.children.push(node);
    });
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function serialize(node) {
  if (node.type === "text") return escapeHtml(node.value);
  if (node.type === "fragment") return node.children.map(serialize).join("");
  const attributes = [
    node.className && `class="${escapeHtml(node.className)}"`,
    node.href && `href="${escapeHtml(node.href)}"`,
    node.target && `target="${escapeHtml(node.target)}"`,
    node.rel && `rel="${escapeHtml(node.rel)}"`
  ].filter(Boolean).join(" ");
  return `<${node.type}${attributes ? ` ${attributes}` : ""}>${node.children.map(serialize).join("")}</${node.type}>`;
}

const previousDocument = globalThis.document;
globalThis.document = {
  createElement: (name) => new TestNode(name),
  createTextNode: (value) => new TestNode("text", value),
  createDocumentFragment: () => new TestNode("fragment")
};

test("Markdown 实际渲染会转义 HTML 并拒绝危险链接", () => {
  const container = new TestNode("div");
  renderMarkdown(container, [
    "# <script>alert(1)</script>",
    "",
    "[危险链接](javascript:alert(1))",
    "",
    "| 来源 | 状态 |",
    "| --- | --- |",
    "| Claude | 支持 |"
  ].join("\n"));

  const html = serialize(container);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<table>/);
  assert.match(html, /危险链接/);
});

test.after(() => {
  globalThis.document = previousDocument;
});
