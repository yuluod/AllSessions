import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

const { filterConversationMessages } =
  await import("../public/conversation-filter.js");

const messages = [
  { role: "user", text: "修复登录问题" },
  { role: "assistant", text: "已经完成" },
  { role: "tool", text: "cargo test", tool_name: "shell" },
  { role: "user", text: "<environment_context>", synthetic_context: true },
];

test("会话过滤同时执行角色、工具、上下文和关键词条件", () => {
  const result = filterConversationMessages(messages, {
    query: "完成",
    showTools: false,
    showContext: false,
    roleFilter: "assistant",
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].text, "已经完成");
  assert.equal(result[0]._origIdx, 1);
});

test("显示工具和系统上下文时保留原始消息索引", () => {
  const result = filterConversationMessages(messages, {
    showTools: true,
    showContext: true,
  });

  assert.deepEqual(
    result.map((message) => message._origIdx),
    [0, 1, 2, 3]
  );
});

test("已移除消息默认隐藏并可通过开关恢复显示", () => {
  const removedMessages = messages.map((message, index) => ({
    ...message,
    _removed: index === 1,
  }));

  assert.deepEqual(
    filterConversationMessages(removedMessages, {
      showTools: true,
      showContext: true,
      showRemoved: false,
    }).map((message) => message._origIdx),
    [0, 2, 3]
  );
  assert.deepEqual(
    filterConversationMessages(removedMessages, {
      showTools: true,
      showContext: true,
      showRemoved: true,
    }).map((message) => message._origIdx),
    [0, 1, 2, 3]
  );
});
