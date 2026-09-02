import assert from "node:assert/strict";
import test from "node:test";

import { markdownToPlainText } from "../public/markdown.js";

test("消息导航摘要移除常见 Markdown 标记", () => {
  const markdown = [
    "# 标题",
    "",
    "- **重点**与[文档](https://example.com)",
    "- `inlineCode`",
    "",
    "```js",
    "const value = 1;",
    "```",
  ].join("\n");

  assert.equal(
    markdownToPlainText(markdown),
    "标题 重点与文档 inlineCode const value = 1;"
  );
});

test("消息导航摘要移除表格分隔线和引用标记", () => {
  const markdown = [
    "> 引用内容",
    "",
    "---",
    "",
    "| 来源 | 状态 |",
    "| --- | --- |",
    "| Claude | **支持** |",
  ].join("\n");

  assert.equal(
    markdownToPlainText(markdown),
    "引用内容 | 来源 | 状态 | | Claude | 支持 |"
  );
});

test("消息导航保留路径和标识符中的下划线", () => {
  const markdown = "读取 `file_path` 和 C:\\项目\\AOIS_完整说明.md";

  assert.equal(
    markdownToPlainText(markdown),
    "读取 file_path 和 C:\\项目\\AOIS_完整说明.md"
  );
});
