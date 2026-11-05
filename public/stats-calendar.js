const DAY_MS = 86_400_000;

export function heatmapNextIndex(index, key, length) {
  const next = {
    ArrowLeft: index - 7,
    ArrowRight: index + 7,
    ArrowUp: index - 1,
    ArrowDown: index + 1,
    Home: 0,
    End: length - 1,
  }[key];
  return next === undefined ? null : Math.max(0, Math.min(length - 1, next));
}

export function statsPresetRange(preset, now = new Date()) {
  if (preset === "all") return { start: "", end: "" };
  const end = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const offset = { today: 0, week: 6, month: 29 }[preset];
  if (offset === undefined) throw new Error("统计日期预设无效");
  return {
    start: new Date(dayTime(end) - offset * DAY_MS).toISOString().slice(0, 10),
    end,
  };
}

function dayTime(date) {
  return Date.parse(`${date}T00:00:00Z`);
}

export function presetHeatmapRange(days, preset = "month", now = new Date()) {
  if (!days.length) return null;
  const end = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  let start;
  if (preset === "all") start = days[0].label;
  else if (preset === "month") start = `${end.slice(0, 7)}-01`;
  else {
    const offset = preset === "week" ? (now.getDay() + 6) % 7 : 29;
    start = new Date(dayTime(end) - offset * DAY_MS).toISOString().slice(0, 10);
  }
  return { start, end };
}

// 按日历补零，不能把无活动日期压掉，否则星期位置和日期范围都会失真。
export function calendarHeatmapDays(days, { start, end }) {
  const requestedFirst = dayTime(start);
  const last = dayTime(end);
  if (
    !Number.isFinite(requestedFirst) ||
    !Number.isFinite(last) ||
    requestedFirst > last
  ) {
    throw new Error("热力图日期范围无效");
  }
  // 图表保持有界，超长范围仅绘制最后 4096 天，汇总数据仍使用完整范围。
  const first = Math.max(requestedFirst, last - 4095 * DAY_MS);
  const indexed = new Map(days.map((day) => [day.label, day]));
  const result = [];
  for (let time = first; time <= last; time += DAY_MS) {
    const label = new Date(time).toISOString().slice(0, 10);
    result.push(indexed.get(label) || { label, count: 0, tokens: 0 });
  }
  return result;
}
