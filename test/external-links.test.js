import assert from "node:assert/strict";
import test from "node:test";

const { bindExternalLinks, isExternalHref } =
  await import("../public/external-links.js");

function createContainer() {
  const listeners = {};
  const anchors = new Set();
  return {
    anchors,
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    },
    contains: (node) => anchors.has(node),
    click(target) {
      const event = {
        target,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      listeners.click?.(event);
      return event;
    },
  };
}

function createAnchor(container, href) {
  const anchor = {
    getAttribute: (name) => (name === "href" ? href : null),
    closest: (selector) => (selector === "a[href]" ? anchor : null),
  };
  container.anchors.add(anchor);
  return anchor;
}

function withTauri(run) {
  const previousWindow = globalThis.window;
  globalThis.window = { __TAURI__: { core: { invoke: () => {} } } };
  return Promise.resolve(run()).finally(() => {
    globalThis.window = previousWindow;
  });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("外链判定只接受 http、https 与 mailto", () => {
  assert.equal(isExternalHref("https://example.com"), true);
  assert.equal(isExternalHref("HTTP://example.com"), true);
  assert.equal(isExternalHref("mailto:a@example.com"), true);
  assert.equal(isExternalHref("#section"), false);
  assert.equal(isExternalHref("javascript:alert(1)"), false);
  assert.equal(isExternalHref(""), false);
});

test("未提供打开函数时不绑定点击拦截", () =>
  withTauri(() => {
    const container = createContainer();
    bindExternalLinks(container, {});
    const event = container.click(
      createAnchor(container, "https://example.com")
    );
    assert.equal(event.defaultPrevented, false);
  }));

test("Tauri 中点击外链交给系统打开并阻止窗口导航", () =>
  withTauri(async () => {
    const container = createContainer();
    const opened = [];
    bindExternalLinks(container, { open: async (url) => opened.push(url) });

    const event = container.click(
      createAnchor(container, "https://example.com/docs")
    );
    await flush();

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(opened, ["https://example.com/docs"]);
  }));

test("非外链被拦截但不调用系统打开", () =>
  withTauri(async () => {
    const container = createContainer();
    const opened = [];
    bindExternalLinks(container, { open: async (url) => opened.push(url) });

    const event = container.click(createAnchor(container, "#heading"));
    await flush();

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(opened, []);
  }));

test("系统打开失败时上报错误信息", () =>
  withTauri(async () => {
    const container = createContainer();
    const errors = [];
    bindExternalLinks(container, {
      open: async () => {
        throw new Error("url not allowed");
      },
      onError: (message) => errors.push(message),
    });

    container.click(createAnchor(container, "https://example.com"));
    await flush();

    assert.deepEqual(errors, ["url not allowed"]);
  }));

test("点击非链接或容器外链接时不拦截", () =>
  withTauri(async () => {
    const container = createContainer();
    const opened = [];
    bindExternalLinks(container, { open: async (url) => opened.push(url) });

    const plain = container.click({ closest: () => null });
    const outsider = {
      getAttribute: () => "https://example.com",
      closest: () => outsider,
    };
    const outside = container.click(outsider);
    await flush();

    assert.equal(plain.defaultPrevented, false);
    assert.equal(outside.defaultPrevented, false);
    assert.deepEqual(opened, []);
  }));

test("缺少 Tauri 运行时时保留浏览器默认行为", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    const container = createContainer();
    const opened = [];
    bindExternalLinks(container, { open: async (url) => opened.push(url) });

    const event = container.click(
      createAnchor(container, "https://example.com")
    );
    await flush();

    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(opened, []);
  } finally {
    globalThis.window = previousWindow;
  }
});
