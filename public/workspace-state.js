// 查询和阅读选择的状态变更入口，不依赖 DOM、IPC 或全局单例。
export function changeSessionSelection(state, key, hit, detailGate) {
  detailGate.cancel();
  state.selectedSessionKey = key;
  state.selectedSearchHit = hit ? { ...hit, sessionKey: key } : null;
  state.currentDetail = null;
}
export function invalidateQuery(state, gates = []) {
  gates.forEach((gate) => gate.cancel());
  state.nextCursor = null;
  state.hasMore = false;
  state.searchTotal = null;
  state.sessionsTotal = null;
  state.statsDirty = true;
}
export function applySessionPage(state, data, searching) {
  state.sessions = data.sessions;
  state.hasMore = data.has_more;
  state.nextCursor = data.next_cursor;
  state.searchTotal = searching ? Number(data.total || 0) : null;
  state.sessionsTotal = searching ? null : data.total;
  state.scanning = data.scanning === true;
}
