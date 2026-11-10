// 仅记录固定指标名和数值；不保留查询词、路径或会话正文。
const metrics = new Map();
export function recordMetric(name, value = 1) {
  if (!Number.isFinite(value)) return;
  const item = metrics.get(name) || { count: 0, total: 0, max: 0, recent: [] };
  item.count++;
  item.total += value;
  item.max = Math.max(item.max, value);
  item.recent.push(value);
  if (item.recent.length > 128) item.recent.shift();
  metrics.set(name, item);
}
export function performanceSnapshot() {
  return Object.fromEntries(
    [...metrics].map(([name, item]) => {
      const sorted = [...item.recent].sort((a, b) => a - b);
      return [
        name,
        {
          count: item.count,
          total: item.total,
          mean: item.total / item.count,
          max: item.max,
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        },
      ];
    })
  );
}
export function resetPerformanceMetrics() {
  metrics.clear();
}
