// 来源栏状态：按按钮对应的来源计算选中态与计数。
export const SOURCE_RAIL_AGENTS = [
  { agent: "codex", kinds: ["codex", "codex_archived"] },
  { agent: "claude", kinds: ["claude"] },
  { agent: "claude_cowork", kinds: ["claude_cowork"] },
  { agent: "gemini", kinds: ["gemini"] },
  { agent: "grok", kinds: ["grok"] },
  { agent: "pi", kinds: ["pi"] },
  { agent: "kimi", kinds: ["kimi"] },
  { agent: "opencode", kinds: ["opencode"] },
  { agent: "kilo", kinds: ["kilo"] },
  { agent: "zcode", kinds: ["zcode"] },
  { agent: "cursor", kinds: ["cursor"] },
  { agent: "devin", kinds: ["devin"] },
  { agent: "copilot", kinds: ["copilot", "vscode_copilot"] },
  { agent: "hermes", kinds: ["hermes"] },
];

export function sourceAgentForKind(sourceKind) {
  if (sourceKind === "claude_code") return "claude";
  if (sourceKind === "codex_archived") return "codex";
  if (sourceKind === "vscode_copilot") return "copilot";
  return sourceKind || "all";
}

export function sourceRailItemState(sourceKind, activeKind, diagnostics, projectCounts = null) {
  const group = sourceAgentForKind(sourceKind);
  // 选中项目时按项目内的来源计数展示，未选中时回退到全局索引诊断。
  const kindCount = (kind) =>
    projectCounts
      ? Number(projectCounts[kind] || 0)
      : Number(diagnostics?.sources?.[kind]?.indexed_sessions || 0);
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
  const hasData = Boolean(diagnostics || projectCounts);
  return {
    count: hasData ? String(count) : "-",
    active,
    empty: hasData && group !== "all" && !active && count === 0,
  };
}
