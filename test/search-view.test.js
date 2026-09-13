import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = { getItem: () => null };
const { searchPattern, bindMatchNavigation } =
  await import("../public/search-view.js");

test("搜索高亮按字面量处理代码符号和中文并保留大小写", () => {
  const text = "HTTP_404 useEffect( 更新";
  assert.deepEqual(
    [...text.matchAll(searchPattern("http_404 useEffect( 更新"))].map(
      (match) => match[0]
    ),
    ["HTTP_404", "useEffect(", "更新"]
  );
  assert.equal(searchPattern("  "), null);
  assert.equal("a+b".match(searchPattern("a+b"))[0], "a+b");
});

test("命中导航从末处向前并循环，空结果禁用按钮", () => {
  const controls = {
    "#detail-search-count": {},
    "#search-previous": {},
    "#search-next": {},
  };
  const positions = [];
  const marks = [0, 1, 2].map((index) => ({
    classList: { add() {}, remove() {} },
    closest: () => null,
    scrollIntoView: () => positions.push(index),
  }));
  globalThis.document = { querySelector: (selector) => controls[selector] };
  try {
    bindMatchNavigation({ querySelectorAll: () => marks });
    controls["#search-previous"].onclick();
    controls["#search-next"].onclick();
    assert.deepEqual(positions, [2, 0]);
    bindMatchNavigation({ querySelectorAll: () => [] });
    assert.equal(controls["#search-next"].disabled, true);
  } finally {
    delete globalThis.document;
  }
});
