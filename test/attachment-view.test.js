import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

class TestNode {
  constructor(type) {
    this.type = type;
    this.children = [];
    this.className = "";
    this.hidden = false;
    this.title = "";
    this.src = "";
    this.textContent = "";
    this.attributes = new Map();
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
    };
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  addEventListener(name, handler) {
    this.listeners.set(name, handler);
  }

  click() {
    this.listeners.get("click")?.();
  }
}

globalThis.document = {
  createElement: (type) => new TestNode(type),
  getElementById: () => null,
  body: new TestNode("body"),
};
globalThis.IntersectionObserver = undefined;

const { attachmentCacheKey, clearAttachmentCache, renderAttachments } =
  await import("../public/attachment-view.js");

const attachment = {
  kind: "image",
  locator: {
    record_fingerprint: "abc",
    line_number: 12,
    path: ["message", "content", 1],
  },
};

test("附件缓存键完整包含 locator", () => {
  const key = attachmentCacheKey("codex:s1", attachment);
  assert.ok(key.startsWith("codex:s1|"));
  assert.ok(key.includes('"record_fingerprint":"abc"'));
  assert.ok(key.includes('"line_number":12'));
  assert.ok(key.includes('"path":["message","content",1]'));
  assert.notEqual(
    key,
    attachmentCacheKey("codex:s2", attachment),
    "不同会话不能共用缓存"
  );
  assert.notEqual(
    key,
    attachmentCacheKey("codex:s1", {
      ...attachment,
      locator: { ...attachment.locator, record_fingerprint: "def" },
    }),
    "原文变化后必须重新读取"
  );
  assert.notEqual(
    key,
    attachmentCacheKey("codex:s1", {
      ...attachment,
      locator: { ...attachment.locator, path: ["message", "content", 2] },
    }),
    "同一记录的不同图片不能共用缓存"
  );
});

test("ZCode 与 Devin 的定位字段也参与缓存键", () => {
  const zcode = (partId) =>
    attachmentCacheKey("zcode:s1", {
      kind: "image",
      locator: { part_id: partId },
    });
  assert.notEqual(zcode("part_a"), zcode("part_b"));

  const devinDesktop = (position, chunkIndex) =>
    attachmentCacheKey("devin:s1", {
      kind: "image",
      locator: { position, chunk_index: chunkIndex },
    });
  assert.notEqual(devinDesktop(0, 1), devinDesktop(0, 2));
  assert.notEqual(devinDesktop(0, 1), devinDesktop(1, 1));

  const devinCli = (nodeId, imageIndex) =>
    attachmentCacheKey("devin:s1", {
      kind: "image",
      locator: { node_id: nodeId, image_index: imageIndex },
    });
  assert.notEqual(devinCli(0, 0), devinCli(0, 1));
  assert.notEqual(devinCli(0, 0), devinCli(1, 0));
});

test("定位字段顺序不影响缓存键，DeepSeek 序号变化会失效", () => {
  const key = (locator) => attachmentCacheKey("deepseek:s1", { locator });
  assert.equal(
    key({ line_number: 2, seq: 0, path: ["data", "content", 0] }),
    key({ path: ["data", "content", 0], seq: 0, line_number: 2 })
  );
  assert.notEqual(key({ seq: 0 }), key({ seq: 1 }));
});

test("同会话多张 ZCode 图片不会共用缓存", async () => {
  clearAttachmentCache();
  let calls = 0;
  const container = new TestNode("div");
  renderAttachments(
    container,
    [
      { kind: "image", locator: { part_id: "part_a" } },
      { kind: "image", locator: { part_id: "part_b" } },
    ],
    {
      sessionKey: "zcode:s1",
      loadAttachment: async (_sessionKey, locator) => {
        calls += 1;
        return { data_url: `data:image/png;base64,${locator.part_id}` };
      },
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "两张图片必须分别请求");
  const cards = container.children[0].children;
  assert.equal(
    cards[0].children[0].children[0].src,
    "data:image/png;base64,part_a"
  );
  assert.equal(
    cards[1].children[0].children[0].src,
    "data:image/png;base64,part_b"
  );
  const rerendered = new TestNode("div");
  renderAttachments(
    rerendered,
    [
      { kind: "image", locator: { part_id: "part_b" } },
      { kind: "image", locator: { part_id: "part_a" } },
    ],
    {
      sessionKey: "zcode:s1",
      loadAttachment: async () => {
        assert.fail("重新渲染应分别复用两张图片的缓存");
      },
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    rerendered.children[0].children.map(
      (card) => card.children[0].children[0].src
    ),
    ["data:image/png;base64,part_b", "data:image/png;base64,part_a"]
  );
});

test("图片按需加载并复用缓存", async () => {
  clearAttachmentCache();
  let calls = 0;
  const loadAttachment = async () => {
    calls += 1;
    return { data_url: "data:image/png;base64,QUJD" };
  };
  const render = () => {
    const container = new TestNode("div");
    renderAttachments(container, [attachment], {
      sessionKey: "codex:s1",
      loadAttachment,
    });
    return container;
  };

  const first = render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  const image = first.children[0].children[0].children[0].children[0];
  assert.equal(image.src, "data:image/png;base64,QUJD");
  assert.equal(image.hidden, false);

  const second = render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "相同定位的图片不应重复请求");
  assert.equal(
    second.children[0].children[0].children[0].children[0].src,
    image.src
  );
});

test("加载失败标记附件卡片并允许点击重试", async () => {
  clearAttachmentCache();
  let calls = 0;
  const container = new TestNode("div");
  renderAttachments(container, [attachment], {
    sessionKey: "codex:s1",
    loadAttachment: async () => {
      calls += 1;
      throw new Error("读取失败");
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const card = container.children[0].children[0];
  assert.equal(card.classList.contains("failed"), true);
  assert.equal(card.children[1].textContent, "图片加载失败");

  card.children[0].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "失败后点击应重新请求");
});

test("非图片附件不渲染", () => {
  const container = new TestNode("div");
  renderAttachments(
    container,
    [{ kind: "audio", locator: attachment.locator }],
    {
      sessionKey: "codex:s1",
      loadAttachment: async () => ({}),
    }
  );
  assert.equal(container.children.length, 0);
});
