import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarHeatmapDays,
  presetHeatmapRange,
} from "../public/stats-calendar.js";

test("热力图按所选日历日期补齐空白日并保留用量", () => {
  const days = [
    { label: "2026-03-07", count: 2, tokens: 100 },
    { label: "2026-03-10", count: 1, tokens: 50 },
  ];
  const calendar = calendarHeatmapDays(days, {
    start: "2026-03-07",
    end: "2026-03-10",
  });
  assert.deepEqual(
    calendar.map((day) => day.label),
    ["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]
  );
  assert.deepEqual(
    calendar.map((day) => day.tokens),
    [100, 0, 0, 50]
  );
  assert.equal(
    calendarHeatmapDays(days, { start: "2026-03-10", end: "2026-03-10" })
      .length,
    1
  );
  assert.throws(() =>
    calendarHeatmapDays(days, { start: "2026-03-10", end: "2026-03-07" })
  );
});

test("常用范围按当前日期计算，本周从周一开始", () => {
  const days = [
    { label: "2026-05-11", count: 1, tokens: 10 },
    { label: "2026-10-12", count: 1, tokens: 20 },
  ];
  const now = new Date(2026, 9, 12, 12);
  const range = presetHeatmapRange(days, "month", now);
  const calendar = calendarHeatmapDays(days, range);
  assert.equal(calendar.length, 12);
  assert.equal(calendar.at(-1).label, "2026-10-12");
  assert.equal(
    calendar.reduce((sum, day) => sum + day.tokens, 0),
    20
  );
  assert.deepEqual(presetHeatmapRange(days, "week", now), {
    start: "2026-10-12",
    end: "2026-10-12",
  });
  assert.deepEqual(
    presetHeatmapRange(days, "week", new Date(2026, 9, 11, 12)),
    { start: "2026-10-05", end: "2026-10-11" }
  );
  assert.equal(
    calendarHeatmapDays(days, presetHeatmapRange(days, "30days", now)).length,
    30
  );
  assert.deepEqual(presetHeatmapRange(days, "all", now), {
    start: "2026-05-11",
    end: "2026-10-12",
  });
  assert.equal(presetHeatmapRange([], "month", now), null);
});
