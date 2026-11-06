import assert from "node:assert/strict";
import test from "node:test";

const { diffLines, editCounts, collectFileEdits } =
  await import("../public/diff-view.js");

test("行级 diff 区分 context/del/add 并保留首尾公共行", () => {
  const rows = diffLines("a\nb\nc", "a\nx\nc");
  assert.deepEqual(
    rows.map((row) => [row.type, row.text]),
    [
      ["context", "a"],
      ["del", "b"],
      ["add", "x"],
      ["context", "c"],
    ]
  );
});

test("成对 del/add 行计算词级 changed 片段", () => {
  const rows = diffLines("const x = 1;", "const x = 2;");
  const del = rows.find((row) => row.type === "del");
  const add = rows.find((row) => row.type === "add");
  assert.deepEqual(
    del.spans.map((span) => [span.text, span.changed]),
    [
      ["const x = ", false],
      ["1", true],
      [";", false],
    ]
  );
  assert.equal(add.spans.find((span) => span.changed).text, "2");
});

test("全新增内容全部标记为 add，删除为 del", () => {
  assert.deepEqual(
    diffLines("", "a\nb").map((row) => row.type),
    ["add", "add"]
  );
  assert.deepEqual(
    diffLines("a\nb", "").map((row) => row.type),
    ["del", "del"]
  );
});

test("editCounts 统计每个编辑段的增删行数", () => {
  assert.deepEqual(editCounts({ old: "a\nb\nc", new: "a\nx\ny\nc" }), {
    added: 2,
    removed: 1,
  });
  assert.deepEqual(editCounts({ old: "", new: "one\ntwo" }), {
    added: 2,
    removed: 0,
  });
});

test("collectFileEdits 按路径聚合多次编辑并保留消息索引", () => {
  const groups = [
    {
      message: {
        _origIdx: 0,
        file_edit: { path: "b.rs", edits: [{ old: "x", new: "y\nz" }] },
      },
    },
    { message: { _origIdx: 1, file_activity: [{ path: "a.rs" }] } },
    {
      message: {
        _origIdx: 2,
        file_edit: {
          path: "a.rs",
          edits: [{ old: "l1\nl2", new: "l1" }],
        },
      },
    },
    {
      message: {
        _origIdx: 3,
        file_edit: { path: "b.rs", edits: [{ old: "p", new: "q" }] },
      },
    },
  ];
  const files = collectFileEdits(groups);
  assert.deepEqual(
    files.map((file) => [
      file.path,
      file.added,
      file.removed,
      file.edits.length,
    ]),
    [
      ["b.rs", 3, 2, 2],
      ["a.rs", 0, 1, 1],
    ]
  );
  assert.equal(files[0].edits[0].index, 0);
  assert.equal(files[0].edits[1].index, 3);
});
