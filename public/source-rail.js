// 来源栏状态：按按钮对应的来源计算选中态与计数。
// kinds 同时列出后端归一键与会话侧原始 source_kind（如 claude_code、
// codex_archived、vscode_copilot），避免再靠散落的特判做 kind→agent 映射。
import { SOURCE_RAIL_AGENTS } from "./source-descriptors.js";
export { SOURCE_RAIL_AGENTS } from "./source-descriptors.js";

export function sourceAgentForKind(sourceKind) {
  if (!sourceKind) return "all";
  return (
    SOURCE_RAIL_AGENTS.find(({ kinds }) => kinds.includes(sourceKind))?.agent ??
    sourceKind
  );
}

// 计数来自 facets 的 source_counts：与项目计数同口径，只含当前显示开关下可见的会话。
export function sourceRailItemState(sourceKind, activeKind, sourceCounts) {
  const group = sourceAgentForKind(sourceKind);
  const kindCount = (kind) => Number(sourceCounts?.[kind] || 0);
  const counts = new Map(
    SOURCE_RAIL_AGENTS.map(({ agent, kinds }) => [
      agent,
      kinds.reduce((total, kind) => total + kindCount(kind), 0),
    ])
  );
  const count =
    group === "all"
      ? [...counts.values()].reduce((total, count) => total + count, 0)
      : counts.get(group) || 0;
  const active = group === sourceAgentForKind(activeKind);
  const hasData = Boolean(sourceCounts);
  return {
    count: hasData ? String(count) : "-",
    active,
    empty: hasData && group !== "all" && !active && count === 0,
  };
}
