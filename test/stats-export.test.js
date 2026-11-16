import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

const { csvCell, statsBreakdownCsv, statsDailyCsv, statsExportData } =
  await import("../public/stats-export.js");

const stats = {
  range: { start: "2026-02-01", end: "2026-02-02" },
  total: 3,
  total_tokens: 1200,
  total_cost: 0.5,
  unpriced_tokens: 200,
  by_date: [
    { label: "2026-02-01", count: 2, tokens: 1000, cost: 0.5 },
    { label: "2026-02-02", count: 1, tokens: null, cost: 0 },
    { label: "2026-02-03", count: 1, tokens: 200, cost: 0 },
  ],
  by_model_tokens: [{ label: "gpt-5", count: 1000 }],
  by_cwd: [
    { label: "/home/alice/project", count: 2 },
    { label: "//server/share/client", count: 1 },
  ],
  by_command: [{ label: '=cmd|"/c calc"', count: 1 }],
  project_review: { cwd: "/home/alice/project", recent: [{ title: "私密" }] },
};

test("统计导出 JSON 保留未知值并排除项目回顾正文", () => {
  const data = statsExportData(stats, { redact: true });
  assert.equal(data.totals.unpriced_tokens, 200);
  assert.equal(data.totals.total_events, null);
  assert.equal(data.by_date[1].tokens, null);
  assert.equal(data.by_cwd[0].label, "[local path 1]");
  assert.equal(data.by_cwd[1].label, "[local path 2]");
  assert.equal(data.by_date[1].cost, 0);
  assert.equal(data.by_date[2].cost, null);
  assert.equal(data.project_review, undefined);
  assert.doesNotMatch(JSON.stringify(data), /私密|alice|server/);

  const unpriced = statsExportData({ ...stats, total_cost: null });
  assert.equal(unpriced.by_date[0].cost, null);
  assert.equal(unpriced.by_cwd[0].label, "/home/alice/project");
});

test("统计 CSV 转义特殊字符并阻止公式注入", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(12), "12");
  assert.equal(csvCell("-1+2"), "'-1+2");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');

  const daily = statsDailyCsv({ ...stats, total_cost: null }).split("\r\n");
  assert.equal(daily[0], "date,sessions,tokens,cost_usd");
  assert.equal(daily[1], "2026-02-01,2,1000,");
  assert.equal(daily[2], "2026-02-02,1,,");

  const breakdown = statsBreakdownCsv(stats, { redact: true });
  assert.match(breakdown, /^dimension,label,count\r\n/);
  assert.match(breakdown, /by_model_tokens,gpt-5,1000/);
  assert.match(breakdown, /by_cwd,\[local path 1\],2/);
  assert.match(breakdown, /by_command,"'=cmd\|""\/c calc""",1/);
});
