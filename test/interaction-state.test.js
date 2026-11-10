import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {
  createLatestRequestGate,
  createRefreshCoordinator,
} from "../public/async-coordinator.js";
import {
  applySessionPage,
  invalidateQuery,
  changeSessionSelection,
} from "../public/workspace-state.js";
import {
  shouldConfirmResume,
  setConfirmResume,
} from "../public/interaction-preferences.js";

// 隔离应用装配和真实 IPC，直接执行生产函数，验证状态变化而非源码形状。
async function loadModule(file, globals) {
  const source = (
    await readFile(new URL(`../public/${file}`, import.meta.url), "utf8")
  )
    .replace(/^import[\s\S]*?from\s+"[^"]+";\s*/gm, "")
    .replace(/^export /gm, "");
  const context = vm.createContext({
    createLatestRequestGate,
    createRefreshCoordinator,
    applySessionPage,
    invalidateQuery,
    changeSessionSelection,
    recordMetric() {},
    ...globals,
  });
  vm.runInContext(source, context);
  return context;
}

function node() {
  return {
    classList: { add() {}, remove() {}, toggle() {} },
    value: "",
    textContent: "",
    querySelector: () => null,
  };
}

test("后台刷新隐藏视图只标记失效，前台查询立即取消旧请求", async () => {
  const state = {
    activeView: "tools",
    statsDirty: false,
    sessionsDirty: false,
  };
  let cancelled = 0;
  const gate = { cancel: () => cancelled++ };
  const app = await loadModule("app/data.js", {
    state,
    sessionRequestGate: gate,
    detailRequestGate: gate,
    statsRequestGate: gate,
    statsSessionsRequestGate: gate,
    createIndexProgressPoller: () => ({}),
    document: { addEventListener() {} },
    fetchJson: () => assert.fail("隐藏列表和统计不应请求数据"),
  });
  await app.refreshWorkspace(["sessions", "stats"]);
  assert.equal(state.sessionsDirty, true);
  assert.equal(state.statsDirty, true);
  assert.equal(cancelled, 2);
});

test("原始事件页在首次切换到该页时才创建节点", async () => {
  let appended = 0;
  const raw = { append: () => appended++, innerHTML: "" };
  const state = { activeTab: "conversation" };
  const viewNode = { classList: { toggle() {} }, setAttribute() {} };
  const app = await loadModule("app/detail-view.js", {
    state,
    elements: {
      rawEvents: raw,
      tabButtons: [],
      conversationTab: viewNode,
      rawTab: viewNode,
    },
    document: { createElement: () => ({}) },
    t: (key) => key,
  });
  app.renderRawEvents([]);
  assert.equal(appended, 0);
  state.activeTab = "raw";
  app.updateTabs();
  assert.equal(appended, 1);
  app.updateTabs();
  assert.equal(appended, 1);
});

test("控制器通过入口注入跨视图行为，不在内部重新装配导航和刷新", async () => {
  const captures = {};
  const factory = (name) => (options) => {
    captures[name] = options;
    return {};
  };
  const context = await loadModule("app/controllers.js", {
    createConversationView: factory("conversation"),
    createSettingsController: factory("settings"),
    createUpdateController: factory("update"),
    createMaintenanceController: factory("maintenance"),
    elements: {},
    state: {},
    isMessageRemoved() {},
    fetchJson() {},
    showError() {},
  });
  const callbacks = {
    onSelectSession() {},
    onRequestDelete() {},
    onRestoreMessage() {},
    onLanguageChanged() {},
    refreshData: async () => {},
  };
  context.initializeControllers(callbacks);
  assert.equal(
    captures.conversation.onSelectSession,
    callbacks.onSelectSession
  );
  assert.equal(
    captures.conversation.onRequestDelete,
    callbacks.onRequestDelete
  );
  assert.equal(
    captures.conversation.onRestoreMessage,
    callbacks.onRestoreMessage
  );
  assert.equal(
    captures.settings.onLanguageChanged,
    callbacks.onLanguageChanged
  );
  assert.equal(captures.maintenance.refreshData, callbacks.refreshData);
});

test("信息栏在宽屏可收起并释放空间，抽屉与停靠状态独立", async () => {
  let drawerLayout = false;
  const classes = new Set();
  const attributes = {};
  const layoutClasses = new Set();
  const classList = (set) => ({
    toggle(name, enabled) {
      if (enabled) set.add(name);
      else set.delete(name);
    },
  });
  let focused = false;
  const inside = {};
  const panel = {
    classList: classList(classes),
    setAttribute: (key, value) => (attributes[key] = value),
    contains: (element) => element === inside,
  };
  const buttonAttributes = {};
  const document = { activeElement: null };
  const state = { currentDetail: {} };
  const context = await loadModule("app/detail-view.js", {
    syncPaneLayout() {},
    state,
    document,
    window: { matchMedia: () => ({ matches: drawerLayout }) },
    INSPECTOR_DRAWER_QUERY: "(max-width: 1640px)",
    elements: {
      propsContent: { closest: () => panel },
      appLayout: { classList: classList(layoutClasses) },
      sessionInspectorToggle: {
        setAttribute: (key, value) => (buttonAttributes[key] = value),
        focus: () => (focused = true),
      },
    },
  });
  const assertOpen = (open) => {
    assert.equal(classes.has("is-open"), open);
    assert.equal(attributes["aria-hidden"], String(!open));
    assert.equal(buttonAttributes["aria-expanded"], String(open));
  };
  context.syncInspectorLayout();
  assertOpen(true);
  document.activeElement = inside;
  context.setInspectorOpen(false);
  assertOpen(false);
  assert.equal(focused, true);
  assert.equal(layoutClasses.has("inspector-collapsed"), true);
  drawerLayout = true;
  context.syncInspectorLayout();
  assertOpen(false);
  context.setInspectorOpen(true);
  assertOpen(true);
  drawerLayout = false;
  context.syncInspectorLayout();
  assertOpen(false);
  context.setInspectorOpen(true);
  assertOpen(true);
  assert.equal(layoutClasses.has("inspector-collapsed"), false);
  context.closeInspectorDrawer();
  assertOpen(true);
  drawerLayout = true;
  context.syncInspectorLayout();
  assertOpen(false);
  state.currentDetail = null;
  context.setInspectorOpen(true);
  assertOpen(false);
});

function dataEnvironment() {
  const state = {
    sessions: [{ _key: "one" }],
    selectedSessionKey: "one",
    currentDetail: { summary: { _key: "one" } },
    roleFilter: "assistant",
    detailQuery: "保留搜索",
    searchQuery: "全局词",
    _initialized: true,
  };
  const scroller = { scrollTop: 120, scrollHeight: 1000, clientHeight: 300 };
  const elements = new Proxy(
    {
      conversationList: { closest: () => scroller, querySelector: () => null },
      sessionList: { querySelectorAll: () => [] },
    },
    { get: (target, key) => target[key] ?? (target[key] = node()) }
  );
  const globals = {
    state,
    elements,
    URLSearchParams,
    console: { error() {} },
    document: { querySelector: () => node(), addEventListener() {} },
    window: { matchMedia: () => ({ matches: false }) },
    requestAnimationFrame: (fn) => fn(),
    MOBILE_LAYOUT_QUERY: "",
    detailRequestGate: createLatestRequestGate(),
    sessionRequestGate: createLatestRequestGate(),
    nextPaint: async () => {},
    isAbortError: () => false,
    isSearchActive: () => false,
    hasSearchOptions: () => false,
    fetchJson: async () => ({
      summary: { _key: "one" },
      conversation_messages: [],
      raw_events: [],
    }),
    conversationView: { renderConversation() {} },
    createIndexProgressPoller: () => ({}),
    sessionNeedsLiveReload: () => false,
    visibleSessions: () => state.sessions,
    t: (key) => key,
  };
  for (const name of [
    "syncRoleFilterButtons",
    "syncDetailTitle",
    "renderDetailTags",
    "syncSessionWorkspaceControls",
    "syncSessionArchiveButton",
    "syncSessionDeleteButton",
    "renderPropsPanel",
    "renderRawEvents",
    "updateTabs",
    "renderSessionList",
    "renderSessionListFooter",
    "syncFilterControls",
    "syncSessionRoot",
    "syncUrl",
    "showError",
    "showSelectSessionPlaceholder",
  ])
    globals[name] = () => {};
  globals.buildSessionsUrl = () => "/sessions";
  return globals;
}

test("同一会话实时更新保留角色、会话内搜索和阅读位置，普通切换重置筛选", async () => {
  const globals = dataEnvironment();
  const app = await loadModule("app/data.js", globals);
  assert.equal(await app.loadSessionDetail("one", { live: true }), true);
  assert.equal(globals.state.roleFilter, "assistant");
  assert.equal(globals.state.detailQuery, "保留搜索");
  assert.equal(globals.elements.conversationList.closest().scrollTop, 120);
  await app.loadSessionDetail("one");
  assert.equal(globals.state.roleFilter, "");
  assert.equal(globals.state.detailQuery, "全局词");
});

test("未变化的会话后台刷新不重新请求详情，也不取消正在进行的详情请求", async () => {
  const globals = dataEnvironment();
  const inFlight = globals.detailRequestGate.begin();
  let requests = 0;
  globals.fetchJson = async () => {
    requests++;
    return { sessions: [{ _key: "one" }], has_more: false };
  };
  const app = await loadModule("app/data.js", globals);
  await app.loadSessions({ background: true });
  assert.equal(requests, 1);
  assert.equal(inFlight.isCurrent(), true);
  assert.equal(globals.state.roleFilter, "assistant");
});

test("查询失败保留旧结果、显示失败状态并禁止继续追加旧分页", async () => {
  const globals = dataEnvironment();
  let requests = 0;
  globals.fetchJson = async () => {
    requests++;
    throw new Error("不可用");
  };
  let statuses = 0;
  globals.renderSessionListFooter = () => statuses++;
  const app = await loadModule("app/data.js", globals);
  assert.equal(await app.loadSessions(), false);
  assert.equal(globals.state.sessions[0]._key, "one");
  assert.equal(globals.state.lastSessionError.message, "不可用");
  assert.equal(globals.state.sessionsLoading, false);
  assert.ok(statuses >= 2);
  assert.equal(await app.loadMoreSessions(), false);
  assert.equal(requests, 1);
});

test("清空关键词仍能看到所有保留的搜索条件", async () => {
  const state = {
    filters: {},
    searchRole: "tool",
    searchTool: "shell",
    searchRegex: true,
    searchFrom: "2026-11-01",
    searchTo: "2026-11-10",
    searchQuery: "",
  };
  const app = await loadModule("app/filters.js", { state, t: (key) => key });
  assert.deepEqual(
    Array.from(app.activeFilterEntries(), (entry) => entry.type),
    ["searchRole", "searchTool", "searchFrom", "searchTo", "searchRegex"]
  );
});

test("搜索列表计数使用匹配数，失败时不继续展示旧总数", async () => {
  const state = { stats: { total: 120 }, searchTotal: 2 };
  const elements = { sessionCount: { textContent: "" } };
  const app = await loadModule("app/session-list.js", {
    state,
    elements,
    isSearchActive: () => true,
    visibleSessions: () => [{}, {}],
  });
  app.updateSessionCount();
  assert.equal(elements.sessionCount.textContent, "2");
  state.lastSessionError = new Error("失败");
  app.updateSessionCount();
  assert.equal(elements.sessionCount.textContent, "—");
});

test("恢复确认偏好可重新开启，存储不可读时默认确认", () => {
  let value = null;
  globalThis.localStorage = {
    getItem: () => value,
    setItem: (_, next) => {
      value = next;
    },
  };
  try {
    assert.equal(shouldConfirmResume(), true);
    setConfirmResume(false);
    assert.equal(shouldConfirmResume(), false);
    setConfirmResume(true);
    assert.equal(shouldConfirmResume(), true);
    globalThis.localStorage.getItem = () => {
      throw new Error("不可读");
    };
    assert.equal(shouldConfirmResume(), true);
  } finally {
    delete globalThis.localStorage;
  }
});

test("详情请求期间继续滚动时，后台更新使用替换前的最新位置", async () => {
  const globals = dataEnvironment();
  globals.nextPaint = async () => {
    globals.elements.conversationList.closest().scrollTop = 240;
  };
  const app = await loadModule("app/data.js", globals);
  await app.loadSessionDetail("one", { live: true });
  assert.equal(globals.elements.conversationList.closest().scrollTop, 240);
});

test("后台更新等待下一帧期间用户滚动时，不恢复旧阅读位置", async () => {
  const globals = dataEnvironment();
  let frame;
  globals.requestAnimationFrame = (callback) => {
    frame = callback;
  };
  const app = await loadModule("app/data.js", globals);
  await app.loadSessionDetail("one", { live: true });
  assert.equal(typeof frame, "function");
  const scroller = globals.elements.conversationList.closest();
  scroller.scrollTop = 360;
  frame();
  assert.equal(scroller.scrollTop, 360);
});
