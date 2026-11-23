import assert from "node:assert/strict";
import test from "node:test";
globalThis.localStorage = { getItem: () => null };
const {
  expireProjectReviewActivity,
  renderProjectReview,
  PROJECT_REVIEW_PAGE_SIZE,
} = await import("../public/project-review.js");
const { RUNNING_WINDOW_MS } = await import("../public/session-format.js");

// 只模拟渲染器用到的节点 API，用于验证展开行为。
class Node {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.events = {};
    this.classList = { toggle() {} };
  }
  setAttribute() {}
  addEventListener(key, callback) {
    this.events[key] = callback;
  }
  append(...nodes) {
    nodes.forEach((node) => {
      if (typeof node === "string") node = { textContent: node };
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
  focus() {
    globalThis.document.activeElement = this;
  }
  querySelectorAll(selector) {
    assert.equal(selector, "[data-project-last-activity]");
    return this.children.flatMap((child) => {
      if (child.dataset?.projectLastActivity) return [child];
      return child.querySelectorAll?.(selector) || [];
    });
  }
}

function mockDocument(t) {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Node(tag) };
  t.after(() => {
    globalThis.document = previous;
  });
}

test("项目回顾默认展示首批条目，展开时将焦点移到新增条目", (t) => {
  mockDocument(t);
  const total = PROJECT_REVIEW_PAGE_SIZE * 2 + 3;
  const recent = Array.from({ length: total }, (_, index) => ({
    key: `codex:${index}`,
    title: `会话 ${index}`,
    source: "Codex",
  }));
  const container = new Node("section");
  renderProjectReview(
    { cwd: "/project", recent, saved: [] },
    container,
    () => {}
  );
  const [recentSection, savedSection] = container.children[2].children;
  const list = recentSection.children[1];
  const more = () =>
    recentSection.children.find(
      (node) => node.className === "stats-activity-link project-review-more"
    );
  assert.equal(list.children.length, PROJECT_REVIEW_PAGE_SIZE);
  assert.match(more().textContent, new RegExp(String(total - 8)));
  more().focus();
  more().events.click();
  assert.equal(list.children.length, PROJECT_REVIEW_PAGE_SIZE * 2);
  assert.equal(globalThis.document.activeElement, list.children[8].children[0]);
  more().focus();
  more().events.click();
  assert.equal(list.children.length, total);
  assert.equal(
    globalThis.document.activeElement,
    list.children[16].children[0]
  );
  assert.equal(more(), undefined);
  assert.equal(
    savedSection.children.some((node) =>
      String(node.className).includes("project-review-more")
    ),
    false
  );
});

test("时间线保留来源、自定义名称及会话入口，原地移除过期活动提示", (t) => {
  mockDocument(t);
  const now = Date.parse("2026-02-03T12:00:00Z");
  t.mock.method(Date, "now", () => now);
  const recent = [
    { key: "codex:future", timestamp: "2026-02-03T12:01:00Z", source: "Codex" },
    {
      key: "claude_code:recent",
      title: "原始名称",
      workspace: { display_name: "自定义名称" },
      source: "Claude Code",
      timestamp: "2026-02-03T11:59:59Z",
      favorite: true,
      tags: ["已验证"],
    },
    { key: "codex:unknown", timestamp: "", source: "Codex" },
  ];
  const container = new Node("section");
  const selections = [];
  renderProjectReview({ cwd: "/project", recent }, container, (key) => {
    selections.push(key);
  });
  const list = container.children[2].children[0].children[1];
  assert.equal(list.tagName, "ol");
  const [button, meta] = list.children[1].children;
  assert.equal(button.textContent, "自定义名称");
  button.events.click();
  assert.deepEqual(selections, ["claude_code:recent"]);
  assert.equal(meta.children[0].textContent, "Claude Code");
  assert.equal(meta.children[2].dateTime, recent[1].timestamp);
  assert.match(meta.children[4].textContent, /收藏.*已验证/);
  const hints = () =>
    container.querySelectorAll("[data-project-last-activity]");
  assert.deepEqual(
    hints().map((hint) => hint.textContent),
    [" · 刚有活动"]
  );
  button.focus();
  expireProjectReviewActivity(container, now + RUNNING_WINDOW_MS);
  assert.equal(hints().length, 0);
  assert.equal(globalThis.document.activeElement, button);
});
