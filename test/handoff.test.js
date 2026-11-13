import assert from "node:assert/strict";
import test from "node:test";

const {
  HANDOFF_LIMITS,
  buildHandoffMarkdown,
  createHandoffDraft,
  handoffLang,
  handoffSelectable,
  orderedSelectionMessages,
  takeChars,
  takeUtf8,
  validateSelections,
} = await import("../public/handoff.js");

const fmt = (value) => String(value ?? "");
const msg = (key, text, extra = {}) => ({
  _message_key: key,
  role: "user",
  timestamp: "2026-11-13T10:00:00Z",
  text,
  ...extra,
});

function draftFor(sessionKey, picks, uiLang = "zh") {
  const draft = createHandoffDraft({ sessionKey, uiLang });
  for (const [key, text, sourceTruncated = false] of picks) {
    draft.selections.set(key, { text, sourceTruncated });
  }
  return draft;
}

test("不可选：软移除、截断占位、缺消息键、空白正文", () => {
  assert.equal(handoffSelectable(msg("k", "hello")), true);
  assert.equal(handoffSelectable(msg("k", "  ")), false);
  assert.equal(handoffSelectable(msg("k", "x", { _removed: true })), false);
  assert.equal(
    handoffSelectable(msg("k", "x", { is_truncation_marker: true })),
    false
  );
  assert.equal(handoffSelectable({ role: "user", text: "x" }), false);
  assert.equal(handoffSelectable(msg("k", null)), false);
});

test("截取保持码点边界", () => {
  assert.deepEqual(takeChars("ab🙂cd", 3), { text: "ab🙂", truncated: true });
  const fit = takeUtf8("a中b", 4); // a(1)+中(3)=4，正好放下
  assert.equal(fit.text, "a中");
  assert.equal(fit.truncated, true);
  assert.equal(takeUtf8("abc", 99).truncated, false);
  assert.equal(handoffLang("zh"), "zh-CN");
  assert.equal(handoffLang("en"), "en");
});

test("选择校验按原因撤下失效项", () => {
  const messages = [
    msg("keep", "保留"),
    msg("gone2", "被移除", { _removed: true }),
    msg("filtered", "被筛选"),
  ];
  const draft = draftFor("s", [
    ["keep", "保留"],
    ["missing", "已消失"],
    ["gone2", "被移除"],
    ["filtered", "被筛选"],
    ["blank", "x"],
  ]);
  draft.selections.delete("blank");
  const visible = new Set(["keep"]);
  const dropped = validateSelections(draft, messages, visible);
  assert.deepEqual([...draft.selections.keys()], ["keep"]);
  assert.deepEqual(dropped.map((item) => item.reason).sort(), [
    "filtered",
    "missing",
    "removed",
  ]);
});

test("摘录顺序固定为消息数组顺序，与点击顺序无关", () => {
  const messages = [msg("a", "甲"), msg("b", "乙"), msg("c", "丙")];
  const draft = draftFor("s", [
    ["c", "丙"],
    ["a", "甲"],
  ]);
  const ordered = orderedSelectionMessages(draft, messages);
  assert.deepEqual(
    ordered.map((m) => m._message_key),
    ["a", "c"]
  );
  const result = buildHandoffMarkdown({
    draft,
    messages,
    summary: { message_count: 3 },
    formatTimestamp: fmt,
  });
  assert.ok(result.text.indexOf("> 甲") < result.text.indexOf("> 丙"));
  assert.match(
    result.text,
    /### 摘录 E1[\s\S]*> 甲[\s\S]*### 摘录 E2[\s\S]*> 丙/
  );
});

test("交接文本结构：格式版本、脱敏引用与完整性说明", () => {
  const draft = draftFor("s", [["k1", "第一条正文"]]);
  const result = buildHandoffMarkdown({
    draft,
    messages: [msg("k1", "第一条正文")],
    summary: { message_count: 9 },
    workspace: { archived: true },
    totalMessages: 9,
    sourceLabel: "Claude Code",
    formatTimestamp: fmt,
  });
  assert.match(result.text, /# 工作交接/);
  assert.match(result.text, /- handoff_format: 1/);
  assert.match(result.text, /- template_language: zh-CN/);
  assert.match(result.text, /- 会话引用：S1（已脱敏，仅在本交接内有效）/);
  assert.match(result.text, /- 工作区归档：是/);
  assert.match(result.text, /- Codex 来源归档：不适用/);
  assert.match(result.text, /会话消息总数 9/);
  assert.match(result.text, /## 完整性说明/);
  assert.match(result.text, /不包含全部历史/);
  assert.equal(result.fixedOverBudget, false);
  assert.ok(result.bytes <= HANDOFF_LIMITS.maxTotalBytes);
});

test("总数未知时写未知；隐藏子会话标注身份", () => {
  const draft = draftFor("s", [["k1", "x"]]);
  const result = buildHandoffMarkdown({
    draft,
    messages: [msg("k1", "x")],
    summary: { hidden: true, hidden_reason: "subagent" },
    totalMessages: null,
    formatTimestamp: fmt,
  });
  assert.match(result.text, /会话消息总数 未知/);
  assert.match(result.text, /- 子会话：subagent/);
});

test("用户输入缺失时明确标注；正文超 2000 字符标记截断", () => {
  const draft = draftFor("s", [["k1", "y".repeat(2100), true]]);
  const result = buildHandoffMarkdown({
    draft,
    messages: [msg("k1", "y")],
    summary: {},
    formatTimestamp: fmt,
  });
  assert.match(result.text, /## 下一步\n\n未填写。/);
  assert.match(result.text, /- 正文截断：是/);
  assert.match(result.text, /正文已截断/);
});

test("空正文选择不生成空摘录", () => {
  const draft = draftFor("s", [
    ["k1", ""],
    ["k2", "有效正文"],
  ]);
  const result = buildHandoffMarkdown({
    draft,
    messages: [msg("k1", "x"), msg("k2", "有效正文")],
    summary: {},
    formatTimestamp: fmt,
  });
  assert.equal(result.included.length, 1);
  assert.ok(!result.text.includes("### 摘录 E2"));
});

test("总预算：CJK 长正文按字节截断、超出摘录列为未纳入且总量不超 32 KiB", () => {
  const longText = "汉".repeat(2000); // 2000 字符 ≈ 6000 B
  const messages = Array.from({ length: 10 }, (_, i) =>
    msg(`m${i}`, `第 ${i + 1} 条`)
  );
  const draft = draftFor(
    "s",
    messages.map((m) => [m._message_key, longText])
  );
  const result = buildHandoffMarkdown({
    draft,
    messages,
    summary: {},
    formatTimestamp: fmt,
  });
  assert.equal(result.fixedOverBudget, false);
  assert.ok(result.bytes <= HANDOFF_LIMITS.maxTotalBytes);
  assert.ok(result.included.length < 10);
  assert.ok(result.omitted.length > 0);
  assert.match(result.text, /超出 32 KiB 上限未纳入：第/);
  // E 编号按最终输出连续编号。
  for (let i = 1; i <= result.included.length; i += 1) {
    assert.match(result.text, new RegExp(`### 摘录 E${i}`));
  }
  assert.ok(result.truncatedKeys.size > 0);
});

test("固定部分超预算时拒绝生成并要求缩短输入", () => {
  const draft = draftFor("s", [["k1", "x"]]);
  draft.nextStep = "长".repeat(12000); // ≈ 36 KiB
  const result = buildHandoffMarkdown({
    draft,
    messages: [msg("k1", "x")],
    summary: {},
    formatTimestamp: fmt,
  });
  assert.equal(result.fixedOverBudget, true);
  assert.equal(result.text, "");
});

test("英文模板使用固定键与 en 语言标记", () => {
  const draft = draftFor("s", [["k1", "hello"]], "en");
  const result = buildHandoffMarkdown({
    draft,
    messages: [msg("k1", "hello")],
    summary: {},
    formatTimestamp: fmt,
  });
  assert.match(result.text, /# Work Handoff/);
  assert.match(result.text, /- template_language: en/);
  assert.match(result.text, /### Excerpt E1/);
  assert.match(result.text, /## Completeness/);
});
