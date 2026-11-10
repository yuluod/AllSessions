import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { planMessageUpdates } from "../public/message-reconciliation.js";

async function environment() {
  const document = { activeElement: null };
  class Node {
    constructor() {
      this.children = [];
      this.dataset = {};
      this.classes = new Set();
      this.parent = null;
      this.classList = {
        contains: (name) => this.classes.has(name),
        add: (name) => this.classes.add(name),
        remove: (name) => this.classes.delete(name),
        toggle: (name, value) =>
          value ? this.classes.add(name) : this.classes.delete(name),
      };
    }
    contains(node) {
      return (
        this === node || this.children.some((child) => child.contains(node))
      );
    }
    append(...nodes) {
      nodes.forEach((node) => this.insertBefore(node, null));
    }
    insertBefore(node, before) {
      node.remove();
      const index = before
        ? this.children.indexOf(before)
        : this.children.length;
      this.children.splice(index, 0, node);
      node.parent = this;
    }
    remove() {
      if (this.contains(document.activeElement))
        document.activeElement = document.body;
      if (this.parent)
        this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
    replaceChildren(...nodes) {
      [...this.children].forEach((node) => node.remove());
      this.append(...nodes);
    }
    setAttribute() {}
    addEventListener() {}
    focus() {
      document.activeElement = this;
    }
    querySelectorAll(selector) {
      return selector.includes("hero-copy") ? [] : this.children;
    }
    querySelector() {
      return null;
    }
    closest() {
      return this.parent;
    }
  }
  document.body = new Node();
  document.activeElement = document.body;
  document.createElement = () => new Node();
  const list = new Node();
  document.body.append(list);
  let parses = 0;
  let builds = 0;
  const template = {
    content: {
      cloneNode() {
        builds++;
        const card = new Node();
        const children = new Map();
        card.querySelector = (selector) => {
          if (selector === ".message-card") return card;
          if (selector === ".message-attachments") return null;
          if (!children.has(selector)) {
            const child = new Node();
            child.classes.add(selector.slice(1));
            card.append(child);
            children.set(selector, child);
          }
          return children.get(selector);
        };
        return card;
      },
    },
  };
  const state = {
    currentDetail: { summary: { _key: "session" } },
    detailQuery: "",
    searchRegex: false,
  };
  const globals = {
    state,
    document,
    performance,
    AbortController,
    JSON,
    Set,
    Map,
    elements: { conversationList: list, conversationItemTemplate: template },
    renderedSessionKey: null,
    highlightController: null,
    renderedCards: new Map(),
    collapsedMessages: new Map(),
    planMessageUpdates,
    getLang: () => "zh",
    t: (key) => key,
    nextPaint: async () => {},
    resetAttachmentObservers() {},
    recordMetric() {},
    displayed: (messages) =>
      messages.map((message, index) => ({
        message: { ...message, _origIdx: index },
      })),
    renderSessionInsights() {},
    operationsView: { render() {} },
    scrollToMessage() {},
    onSelectSession() {},
    renderMessageNavigation() {},
    displayRoleLabel: (role) => role,
    formatListTimestamp: () => "",
    formatTimestamp: () => "",
    displayMessageText: (message) => message.text,
    renderMarkdown: () => parses++,
    markdownToPlainText: (text) => text,
    highlightMatches() {},
    setMessageCardCollapsed() {},
    bindMatchNavigation() {},
    messageNavSpyUpdate: null,
    layoutMessageOutlineRail() {},
    CSS: { escape: (value) => value },
  };
  const source = await readFile(
    new URL("../public/conversation-view.js", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("  async function renderConversation(messages)");
  const end = source.indexOf(
    "  return { renderConversation, moveUserMessage }",
    start
  );
  assert.ok(start > 0 && end > start);
  const context = vm.createContext(globals);
  vm.runInContext(source.slice(start, end), context);
  return {
    context,
    state,
    list,
    document,
    Node,
    builds: () => builds,
    parses: () => parses,
  };
}

test("真实消息渲染器在单条追加时复用已有卡片及其焦点", async () => {
  const env = await environment();
  const messages = Array.from({ length: 20 }, (_, index) => ({
    _message_key: String(index),
    role: "assistant",
    text: "正文",
  }));
  await env.context.renderConversation(messages);
  const first = env.list.children[0];
  const control = first.querySelector(".message-toggle");
  control.focus();
  messages.push({ _message_key: "20", role: "user", text: "追加" });
  await env.context.renderConversation(messages);
  assert.equal(env.list.children[0], first);
  assert.equal(env.document.activeElement, control);
  assert.equal(env.builds(), 21);
  assert.equal(env.parses(), 21);
  messages[19].text = "改变";
  await env.context.renderConversation(messages);
  assert.equal(env.builds(), 22);
  assert.equal(env.list.children.length, 21);
});

test("分段渲染在会话切换后停止，后续新会话不残留旧卡片", async () => {
  const env = await environment();
  let release;
  env.context.nextPaint = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = env.context.renderConversation(
    Array.from({ length: 50 }, (_, i) => ({
      _message_key: String(i),
      role: "assistant",
      text: "正文",
    }))
  );
  assert.equal(typeof release, "function");
  const built = env.builds();
  env.state.currentDetail = { summary: { _key: "other" } };
  release();
  await pending;
  assert.equal(env.builds(), built);
  env.context.nextPaint = async () => {};
  await env.context.renderConversation([
    { _message_key: "new", role: "user", text: "新会话" },
  ]);
  assert.equal(env.list.children.length, 1);
  assert.equal(env.list.children[0].dataset.messageKey, "new");
});

test("更新卡片等待期间用户移走焦点，完成后不抢回旧消息", async () => {
  const env = await environment();
  const messages = Array.from({ length: 20 }, (_, i) => ({
    _message_key: String(i),
    role: "assistant",
    text: "正文",
  }));
  await env.context.renderConversation(messages);
  env.list.children[0].querySelector(".message-toggle").focus();
  let release;
  env.context.nextPaint = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = env.context.renderConversation(
    messages.map((message) => ({ ...message, text: "更新" }))
  );
  const outside = new env.Node();
  env.document.body.append(outside);
  outside.focus();
  env.context.nextPaint = async () => {};
  release();
  await pending;
  assert.equal(env.document.activeElement, outside);
});
