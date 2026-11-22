import assert from "node:assert/strict";
import test from "node:test";
globalThis.localStorage = { getItem: () => null };
const { renderProjectReview, PROJECT_REVIEW_PAGE_SIZE } =
  await import("../public/project-review.js");

// 只模拟渲染器用到的节点 API，用于验证展开行为。
class Node {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.events = {};
    this.classList = { toggle() {} };
  }
  setAttribute() {}
  addEventListener(key, callback) {
    this.events[key] = callback;
  }
  append(...nodes) {
    nodes.forEach((node) => {
      node.parent = this;
      this.children.push(node);
    });
  }
  replaceChildren() {
    this.children = [];
  }
  remove() {
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
  }
}

test("项目回顾默认展示首批条目，按步长展开至全部后移除按钮", (t) => {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Node(tag) };
  t.after(() => {
    globalThis.document = previous;
  });
  const total = PROJECT_REVIEW_PAGE_SIZE * 2 + 3;
  const recent = Array.from({ length: total }, (_, index) => ({
    key: `codex:${index}`,
    title: `会话 ${index}`,
    source: "Codex",
  }));
  const container = new Node("section");
  renderProjectReview({ cwd: "/project", recent, saved: [] }, container);
  const [recentSection, savedSection] = container.children[2].children;
  const list = recentSection.children[1];
  const more = () =>
    recentSection.children.find(
      (node) => node.className === "stats-activity-link project-review-more"
    );
  assert.equal(list.children.length, PROJECT_REVIEW_PAGE_SIZE);
  assert.match(more().textContent, new RegExp(String(total - 8)));
  more().events.click();
  assert.equal(list.children.length, PROJECT_REVIEW_PAGE_SIZE * 2);
  more().events.click();
  assert.equal(list.children.length, total);
  assert.equal(more(), undefined);
  assert.equal(
    savedSection.children.some((node) =>
      String(node.className).includes("project-review-more")
    ),
    false
  );
});
