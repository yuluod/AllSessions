import assert from "node:assert/strict";
import test from "node:test";
globalThis.localStorage = { getItem: () => null };
const { renderStatsSessionList } =
  await import("../public/stats-session-list.js");

// 只模拟节点身份、移除与焦点，用于验证真实渲染器的异步更新边界。
function setup() {
  const document = { activeElement: null };
  class Node {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.attributes = {};
      this.events = {};
      this.hidden = false;
    }
    contains(node) {
      return (
        this === node || this.children.some((child) => child.contains(node))
      );
    }
    // 生产代码按语义类名取空态标题，桩提供最小类名查找。
    querySelector(selector) {
      const className = selector.replace(/^\./, "");
      const visit = (node) => {
        for (const child of node.children) {
          if (selector.startsWith(".") && child.className === className)
            return child;
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      return visit(this);
    }
    setAttribute(key, value) {
      this.attributes[key] = value;
    }
    addEventListener(key, callback) {
      this.events[key] = callback;
    }
    focus() {
      document.activeElement = this;
    }
    remove() {
      if (this.contains(document.activeElement))
        document.activeElement = document.body;
      if (this.parent)
        this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
    insertBefore(node, next) {
      node.remove();
      const index = next ? this.children.indexOf(next) : this.children.length;
      this.children.splice(index, 0, node);
      node.parent = this;
    }
    append(...nodes) {
      nodes.forEach((node) => this.insertBefore(node, null));
    }
    replaceChildren(...nodes) {
      [...this.children].forEach((node) => node.remove());
      this.append(...nodes);
    }
  }
  document.createElement = (tag) => new Node(tag);
  document.body = new Node("body");
  const container = new Node("section");
  document.body.append(container);
  return { document, container, Node };
}

test("统计分页保留节点与焦点，最后一页将按钮焦点交给新增会话", (t) => {
  const previous = globalThis.document;
  const { document, container } = setup();
  globalThis.document = document;
  t.after(() => {
    globalThis.document = previous;
  });
  let requests = 0;
  const callbacks = {
    onMore: () => requests++,
    onSort() {},
    onRetry() {},
    onSelectSession() {},
  };
  const first = { _key: "first", title: "第一条" };
  const second = { _key: "second", title: "第二条" };
  const data = { sessions: [first], total: 2, has_more: true };
  renderStatsSessionList(container, { data }, callbacks);
  const select = container.children[0].children[1];
  const row = container.children[2].children[0];
  const more = container.children[6];
  more.focus();
  renderStatsSessionList(container, { data, loading: true }, callbacks);
  assert.equal(container.children[0].children[1], select);
  assert.equal(container.children[2].children[0], row);
  assert.equal(document.activeElement, more);
  more.events.click();
  assert.equal(requests, 0);
  renderStatsSessionList(
    container,
    { data: { sessions: [first, second], total: 2, has_more: false } },
    callbacks
  );
  assert.equal(container.children[2].children[0], row);
  assert.equal(
    document.activeElement,
    container.children[2].children[1].children[0]
  );
});

test("统计重试保留等待焦点，用户离开后完成排序不抢焦点", (t) => {
  const previous = globalThis.document;
  const { document, container, Node } = setup();
  globalThis.document = document;
  t.after(() => {
    globalThis.document = previous;
  });
  const callbacks = {
    onSort() {},
    onMore() {},
    onRetry() {},
    onSelectSession() {},
  };
  renderStatsSessionList(container, { error: { message: "失败" } }, callbacks);
  const retry = container.children[5];
  retry.focus();
  renderStatsSessionList(container, { loading: true }, callbacks);
  assert.equal(retry.hidden, false);
  assert.equal(document.activeElement, retry);
  const outside = new Node("button");
  document.body.append(outside);
  outside.focus();
  renderStatsSessionList(
    container,
    { data: { sessions: [], total: 0 } },
    callbacks
  );
  assert.equal(document.activeElement, outside);
  const select = container.children[0].children[1];
  select.focus();
  renderStatsSessionList(
    container,
    { loading: true, sort: "tokens" },
    callbacks
  );
  assert.equal(document.activeElement, select);
  outside.focus();
  renderStatsSessionList(
    container,
    { data: { sessions: [], total: 0 }, sort: "tokens" },
    callbacks
  );
  assert.equal(document.activeElement, outside);
});
