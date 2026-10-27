import assert from "node:assert/strict";
import test from "node:test";
import {
  projectNavEntries,
  projectSourceCount,
  projectSourceTimestamp,
} from "../public/project-nav.js";

const projects = [
  {
    name: "alpha",
    path: "/work/alpha",
    count: 5,
    source_counts: { codex: 3, codex_archived: 2, claude_code: 2 },
    source_last_timestamps: {
      codex: "2026-10-01T00:00:00Z",
      codex_archived: "2026-10-05T00:00:00Z",
      claude_code: "2026-10-02T00:00:00Z",
    },
  },
  {
    name: "beta",
    path: "/work/beta",
    count: 4,
    source_counts: { codex: 4, vscode_copilot: 1 },
    source_last_timestamps: {
      codex: "2026-10-06T00:00:00Z",
      vscode_copilot: "2026-10-03T00:00:00Z",
    },
  },
  {
    name: "gamma",
    path: "/work/gamma",
    count: 2,
    source_counts: { gemini: 2 },
    source_last_timestamps: { gemini: "2026-10-07T00:00:00Z" },
  },
];

const pairs = (entries) =>
  entries.map(({ project, count }) => [project.path, count]);

test("未选来源时沿用全局项目计数与顺序", () => {
  assert.deepEqual(pairs(projectNavEntries(projects, "", "")), [
    ["/work/alpha", 5],
    ["/work/beta", 4],
    ["/work/gamma", 2],
  ]);
  assert.equal(projectSourceCount(projects[0], ""), 5);
});

test("选中来源时按来源栏分组计数并隐藏零会话项目", () => {
  // Codex 分组含归档会话，与后端 source_kind=codex 的过滤口径一致。
  assert.equal(projectSourceCount(projects[0], "codex"), 5);
  assert.equal(projectSourceCount(projects[1], "codex"), 4);
  assert.equal(projectSourceCount(projects[2], "codex"), 0);
  // Copilot 分组含 VS Code Copilot Chat。
  assert.equal(projectSourceCount(projects[1], "copilot"), 1);

  assert.deepEqual(pairs(projectNavEntries(projects, "codex", "")), [
    ["/work/beta", 4],
    ["/work/alpha", 5],
  ]);
  assert.deepEqual(pairs(projectNavEntries(projects, "copilot", "")), [
    ["/work/beta", 1],
  ]);
});

test("来源筛选下按该来源最近使用时间排序", () => {
  assert.equal(
    projectSourceTimestamp(projects[0], "codex"),
    "2026-10-05T00:00:00Z"
  );
  assert.equal(
    projectSourceTimestamp(projects[1], "copilot"),
    "2026-10-03T00:00:00Z"
  );
  assert.equal(projectSourceTimestamp(projects[2], "codex"), "");
});

test("当前选中项目在该来源下无会话时保留并计零", () => {
  assert.deepEqual(
    pairs(projectNavEntries(projects, "gemini", "/work/alpha")),
    [
      ["/work/gamma", 2],
      ["/work/alpha", 0],
    ]
  );
});

test("缺少 source_counts 的项目按零计数", () => {
  assert.equal(projectSourceCount({ count: 2 }, "codex"), 0);
  assert.equal(projectSourceCount(undefined, "codex"), 0);
  assert.equal(projectSourceCount(undefined, ""), 0);
  assert.equal(projectSourceTimestamp(undefined, "codex"), "");
});
