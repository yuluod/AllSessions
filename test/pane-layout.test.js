import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map();
const classes = new Set();
const shell = {
  classList: {
    contains(name) {
      return classes.has(name);
    },
    toggle(name, force) {
      const next = force === undefined ? !classes.has(name) : Boolean(force);
      if (next) classes.add(name);
      else classes.delete(name);
      return next;
    },
  },
};
const attributes = new Map();
let clickHandler = null;
const toggle = {
  title: "",
  setAttribute(name, value) {
    attributes.set(name, value);
  },
  addEventListener(event, handler) {
    if (event === "click") clickHandler = handler;
  },
};

globalThis.localStorage = {
  getItem(key) {
    return storage.get(key) ?? null;
  },
  setItem(key, value) {
    storage.set(key, value);
  },
};
globalThis.window = {
  matchMedia() {
    return { matches: false, addEventListener() {} };
  },
};
globalThis.document = {
  documentElement: { style: { setProperty() {}, removeProperty() {} } },
  querySelector(selector) {
    if (selector === ".page-shell") return shell;
    if (selector === "#rail-toggle") return toggle;
    return null;
  },
  querySelectorAll() {
    return [];
  },
};

const { initPaneLayout, setRailCollapsed } =
  await import("../public/pane-layout.js");

test("侧栏收起状态持久化并同步无障碍标签", () => {
  storage.set("allsessions_source_rail_collapsed", "true");
  initPaneLayout();
  assert.equal(classes.has("rail-collapsed"), true);
  assert.equal(attributes.get("aria-expanded"), "false");
  assert.equal(toggle.title, "展开来源栏");

  clickHandler();
  assert.equal(classes.has("rail-collapsed"), false);
  assert.equal(attributes.get("aria-expanded"), "true");
  assert.equal(toggle.title, "收起来源栏");
  assert.equal(storage.get("allsessions_source_rail_collapsed"), "false");

  setRailCollapsed(true);
  assert.equal(classes.has("rail-collapsed"), true);
  assert.equal(attributes.get("aria-expanded"), "false");
  assert.equal(storage.get("allsessions_source_rail_collapsed"), "true");
});
