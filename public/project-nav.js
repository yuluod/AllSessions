// 项目导航状态：按当前来源计算项目计数、可见项目与排序。
// 来源栏把归档 Codex 与 VS Code Copilot Chat 归入对应分组，
// 计数与后端 source_kind 过滤保持同一口径。
const SOURCE_KIND_GROUPS = {
  codex: ["codex", "codex_archived"],
  copilot: ["copilot", "vscode_copilot"],
};

export function sourceKindGroup(sourceKind) {
  return SOURCE_KIND_GROUPS[sourceKind] || [sourceKind];
}

export function projectSourceCount(project, sourceKind) {
  if (!sourceKind) return Number(project?.count || 0);
  const counts = project?.source_counts || {};
  return sourceKindGroup(sourceKind).reduce(
    (total, kind) => total + Number(counts[kind] || 0),
    0
  );
}

export function projectSourceTimestamp(project, sourceKind) {
  const stamps = project?.source_last_timestamps || {};
  return sourceKindGroup(sourceKind).reduce((latest, kind) => {
    const value = stamps[kind] || "";
    return value > latest ? value : latest;
  }, "");
}

export function projectNavEntries(projects, sourceKind, selectedPath) {
  const entries = projects
    .map((project) => ({
      project,
      count: projectSourceCount(project, sourceKind),
    }))
    // 选中来源时只保留该来源有会话的项目；当前选中的项目始终保留，
    // 避免筛选后选中态从导航中消失。
    .filter(
      ({ project, count }) =>
        !sourceKind || count > 0 || project.path === selectedPath
    );
  if (!sourceKind) return entries;
  // 来源筛选下按该来源的最近使用时间排序；无该来源记录的项目排到最后。
  return entries.sort((left, right) =>
    projectSourceTimestamp(right.project, sourceKind).localeCompare(
      projectSourceTimestamp(left.project, sourceKind)
    )
  );
}
