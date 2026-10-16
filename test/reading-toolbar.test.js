import assert from "node:assert/strict";
import test from "node:test";
import { initReadingToolbar } from "../public/reading-toolbar.js";

test("阅读工具区避开原标题，并在标题换行后更新吸附高度", (t) => {
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  let onScroll;
  let onResize;
  let reading = false;
  let backTopHidden = true;
  let onBackTop;
  let scrollOptions;
  let reducedMotion = false;
  const variables = new Map();
  const title = { offsetHeight: 32 };
  const toolbar = { offsetHeight: 95 };
  const panel = {
    scrollTop: 0,
    clientHeight: 400,
    scrollTo: (options) => (scrollOptions = options),
    querySelector: (selector) =>
      selector === "#detail-title" ? title : toolbar,
    classList: { toggle: (_name, value) => (reading = value) },
    addEventListener: (_name, listener) => (onScroll = listener),
    style: { setProperty: (name, value) => variables.set(name, value) },
  };
  const backTop = {
    classList: { toggle: (_name, hidden) => (backTopHidden = hidden) },
    addEventListener: (_name, callback) => (onBackTop = callback),
  };
  const replacements = {
    document: {
      querySelector: (selector) =>
        selector === "#reading-back-top" ? backTop : panel,
    },
    window: { matchMedia: () => ({ matches: reducedMotion }) },
    ResizeObserver: class {
      constructor(callback) {
        onResize = callback;
      }
      observe() {}
    },
  };
  Object.assign(globalThis, replacements);
  t.after(() => {
    for (const key of Object.keys(replacements)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete globalThis[key];
    }
  });
  initReadingToolbar();
  assert.equal(reading, false);
  assert.equal(backTopHidden, true);
  assert.equal(variables.get("--reading-title-height"), "40px");
  panel.scrollTop = 100;
  onScroll();
  assert.equal(reading, true);
  assert.equal(backTopHidden, true);
  panel.scrollTop = 300;
  onScroll();
  assert.equal(backTopHidden, false);
  onBackTop();
  assert.deepEqual(scrollOptions, { top: 0, behavior: "smooth" });
  reducedMotion = true;
  onBackTop();
  assert.deepEqual(scrollOptions, { top: 0, behavior: "auto" });
  title.offsetHeight = 56;
  onResize();
  assert.equal(variables.get("--reading-title-height"), "64px");
  panel.scrollTop = 0;
  onScroll();
  assert.equal(reading, false);
  assert.equal(backTopHidden, true);
});
