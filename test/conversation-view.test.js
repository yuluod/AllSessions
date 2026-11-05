import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

const {
  filterConversationMessages,
  filterToolOperations,
  groupToolMessages,
  roleCounts,
} = await import("../public/conversation-filter.js");
const { fileActivity } = await import("../public/session-insights.js");

test("文件活动汇总保留动作差异和原始消息定位", () => {
  const groups = [
    {
      message: {
        role: "tool",
        _origIdx: 2,
        file_activity: [{ path: "a.rs", action: "read" }],
      },
    },
    {
      message: {
        role: "tool",
        _origIdx: 4,
        file_activity: [
          { path: "a.rs", action: "read" },
          { path: "a.rs", action: "edit" },
        ],
      },
    },
  ];
  assert.deepEqual(fileActivity(groups), [
    { path: "a.rs", action: "read", count: 2, index: 2 },
    { path: "a.rs", action: "edit", count: 1, index: 4 },
  ]);
  assert.equal(
    filterToolOperations(groups, { kind: "files", query: "a.rs" }).length,
    2
  );
  assert.equal(filterToolOperations(groups, { kind: "commands" }).length, 0);
});

const messages = [
  { role: "user", text: "修复登录问题" },
  { role: "assistant", text: "已经完成" },
  { role: "tool", text: "cargo test", tool_name: "shell" },
  { role: "user", text: "<environment_context>", synthetic_context: true },
];

test("操作回顾按归一化命令和明确失败筛选并保留原消息索引", () => {
  const groups = groupToolMessages([
    {
      role: "tool",
      tool_kind: "tool_call",
      tool_call_id: "c1",
      tool_name: "shell",
      command_name: "cargo",
      text: "cargo test",
      _origIdx: 4,
    },
    {
      role: "tool",
      tool_kind: "tool_result",
      tool_call_id: "c1",
      text: "测试失败",
      is_error: true,
      _origIdx: 5,
    },
    {
      role: "tool",
      tool_kind: "tool_result",
      tool_name: "read_file",
      text: "error 是文档中的单词",
      _origIdx: 6,
    },
    { role: "assistant", text: "完成", _origIdx: 7 },
  ]);
  assert.equal(filterToolOperations(groups).length, 2);
  assert.equal(
    filterToolOperations(groups, { kind: "commands" })[0].message._origIdx,
    4
  );
  assert.equal(filterToolOperations(groups, { kind: "errors" }).length, 1);
  assert.equal(
    filterToolOperations(groups, { query: "测试失败" })[0].result._origIdx,
    5
  );
  assert.equal(filterToolOperations(groups, { query: "不存在" }).length, 0);
});

test("角色计数用于只显示当前会话存在的角色", () => {
  const counts = roleCounts(messages);
  assert.equal(counts.get("user"), 2);
  assert.equal(counts.get("assistant"), 1);
  assert.equal(counts.get("tool"), 1);
  assert.equal(counts.get("developer"), undefined);
  assert.equal(roleCounts([]).size, 0);
});

test("搜索定位仅临时显示目标工具消息且不改变偏好", () => {
  const tools = [
    { role: "tool", text: "其他工具", search_ordinal: 5 },
    { role: "tool", text: "目标工具", search_ordinal: 6 },
  ];
  const options = { showTools: false, searchTargetOrdinal: 6 };
  assert.deepEqual(
    filterConversationMessages(tools, options).map((m) => m.search_ordinal),
    [6]
  );
  assert.equal(options.showTools, false);
  assert.deepEqual(
    filterConversationMessages(tools, { showTools: options.showTools }),
    []
  );
});

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

test("工具调用与结果按 tool_call_id 合并为一个渲染单元", () => {
  const groups = groupToolMessages([
    { role: "user", text: "跑测试" },
    {
      role: "tool",
      text: "cargo test",
      tool_kind: "tool_call",
      tool_call_id: "call-1",
    },
    {
      role: "tool",
      text: "全部通过",
      tool_kind: "tool_result",
      tool_call_id: "call-1",
    },
    { role: "assistant", text: "完成" },
  ]);

  assert.deepEqual(
    groups.map((group) => group.message.text),
    ["跑测试", "cargo test", "完成"]
  );
  assert.equal(groups[1].result.text, "全部通过");
  assert.equal(groups[0].result, null);
});

test("Codex 归一化工具调用与结果按标识合并", () => {
  const call = {
    role: "tool",
    tool_kind: "function_call",
    tool_call_id: "codex-call-1",
    tool_name: "shell",
    text: '{"command":"pwd"}',
  };
  const result = {
    role: "tool",
    tool_kind: "function_call_output",
    tool_call_id: "codex-call-1",
    tool_name: "shell",
    text: "/work",
  };
  assert.deepEqual(groupToolMessages([call, result]), [
    { message: call, result },
  ]);
});

test("配对失败时工具消息保持独立", () => {
  const groups = groupToolMessages([
    {
      role: "tool",
      text: "先到的结果",
      tool_kind: "tool_result",
      tool_call_id: "call-1",
    },
    {
      role: "tool",
      text: "后到的调用",
      tool_kind: "tool_call",
      tool_call_id: "call-1",
    },
    { role: "tool", text: "缺少标识", tool_kind: "tool_call" },
    { role: "tool", text: "普通工具消息", tool_name: "shell" },
  ]);

  assert.equal(groups.length, 4);
  assert.ok(groups.every((group) => group.result === null));
});

test("同一结果不会被两个调用重复消费", () => {
  const groups = groupToolMessages([
    {
      role: "tool",
      text: "调用 A",
      tool_kind: "tool_call",
      tool_call_id: "call-1",
    },
    {
      role: "tool",
      text: "调用 B",
      tool_kind: "tool_call",
      tool_call_id: "call-1",
    },
    {
      role: "tool",
      text: "唯一结果",
      tool_kind: "tool_result",
      tool_call_id: "call-1",
    },
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].result.text, "唯一结果");
  assert.equal(groups[1].result, null);
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
