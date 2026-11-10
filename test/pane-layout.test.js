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

const { initPaneLayout, setRailCollapsed, fitPaneWidths, syncPaneLayout } =
  await import("../public/pane-layout.js");

test("拖宽两侧栏时联合保留正文空间，放大窗口恢复原始偏好", () => {
  const preferred = { rail: 400, list: 760 };
  const fitted = fitPaneWidths({ ...preferred, budget: 900 });
  assert.ok(fitted.rail + fitted.list <= 900);
  assert.ok(fitted.rail >= 180);
  assert.ok(fitted.list >= 320);
  assert.deepEqual(fitPaneWidths({ ...preferred, budget: 2000 }), preferred);
  const collapsed = fitPaneWidths({
    rail: 56,
    list: 760,
    budget: 700,
    railCollapsed: true,
  });
  assert.equal(collapsed.rail, 56);
  assert.equal(collapsed.list, 644);
});

test("小窗口启动不会裁掉已保存栏宽，放大后恢复完整偏好", () => {
  const values = new Map();
  globalThis.document.documentElement.style = {
    setProperty: (key, value) => values.set(key, value),
    removeProperty: (key) => values.delete(key),
  };
  storage.set(
    "allsessions_pane_widths",
    JSON.stringify({ rail: 400, list: 760 })
  );
  storage.set("allsessions_source_rail_collapsed", "false");
  globalThis.window.innerWidth = 1100;
  initPaneLayout();
  assert.ok(
    parseInt(values.get("--rail-w")) + parseInt(values.get("--list-w")) <= 580
  );
  globalThis.window.innerWidth = 2400;
  syncPaneLayout();
  assert.equal(values.get("--rail-w"), "400px");
  assert.equal(values.get("--list-w"), "760px");
  assert.deepEqual(JSON.parse(storage.get("allsessions_pane_widths")), {
    rail: 400,
    list: 760,
  });
});

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
