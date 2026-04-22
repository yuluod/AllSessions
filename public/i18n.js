const LANG_KEY = "codex_viewer_lang";

const DICT = {
  zh: {
    title: "Codex 会话查看器",
    eyebrowLocal: "LOCAL SESSION VIEWER",
    description: "筛选、切换并查看本机 Codex 历史会话。",
    metaSessionCount: "会话数量",
    metaDataSource: "数据源",
    loading: "加载中...",
    eyebrowStats: "STATISTICS",
    statsOverview: "会话统计概览",
    eyebrowFilter: "FILTER & BROWSE",
    sessionList: "会话列表",
    refresh: "刷新",
    refreshing: "刷新中...",
    clear: "清空",
    showArchived: "显示已归档会话",
    search: "搜索",
    searchPlaceholder: "搜索会话内容...",
    provider: "Provider",
    date: "日期",
    cwd: "工作目录",
    all: "全部",
    sortDesc: "按时间倒序",
    listHint: "选择一条会话查看详情",
    listAriaLabel: "会话列表",
    tabsAriaLabel: "详情视图切换",
    selectSession: "选择一个会话",
    selectSessionDesc: "左侧会显示所有已解析会话。选中后，右侧会保持在当前工作台里展示摘要、对话视图和原始事件流。",
    eyebrowDetail: "SESSION DETAIL",
    tabConversation: "对话视图",
    tabRaw: "原始事件流",
    exportMd: "导出为 Markdown 文件",
    exportJson: "导出为 JSON 文件",
    providerLabel: "Provider",
    startTime: "开始时间",
    lastTime: "最后时间",
    source: "来源",
    originator: "发起端",
    cwdLabel: "工作目录",
    eventCount: "事件数",
    sessionId: "会话 ID",
    filePath: "文件路径",
    noConversations: "这个会话没有可整理的对话消息，建议切到原始事件流查看。",
    copyMessage: "复制消息内容",
    copy: "复制",
    copied: "✓",
    copyFailed: "失败",
    linePrefix: "第 {n} 行",
    loadMore: "加载更多",
    loadingMore: "加载中...",
    noResults: "当前筛选条件下没有会话。",
    noWorkDir: "未记录工作目录",
    loadDetailFailed: "加载会话详情失败",
    loadListFailed: "加载会话列表失败",
    loadMoreFailed: "加载更多失败",
    refreshFailed: "刷新失败",
    searchFailed: "搜索失败",
    statsRecentDaily: "近期每日会话数",
    statsCommonProvider: "常用 Provider",
    statsCommonCwd: "常用工作目录",
    unknownTime: "未知时间",
    noCwd: "(无工作目录)",
    eventsCount: "{n} 条事件",
    unknownSource: "未知来源",
    unarchive: "取消归档",
    archive: "归档此会话",
    newSessionAdded: "新会话已添加",
    session: "会话",
    requestFailed: "请求失败: {status}",
    errorUnknown: "未知错误",
    forbidden: "禁止访问",
    notFound: "未找到页面",
    methodNotAllowed: "仅支持 GET",
    badRequest: "无效请求",
    missingQuery: "缺少搜索关键词",
    invalidSessionId: "无效的会话 ID",
    sessionNotFound: "会话不存在",
    serverError: "服务器内部错误",
  },
  en: {
    title: "Codex Session Viewer",
    eyebrowLocal: "LOCAL SESSION VIEWER",
    description: "Filter, switch, and browse local Codex session history.",
    metaSessionCount: "Session Count",
    metaDataSource: "Data Source",
    loading: "Loading...",
    eyebrowStats: "STATISTICS",
    statsOverview: "Session Statistics",
    eyebrowFilter: "FILTER & BROWSE",
    sessionList: "Session List",
    refresh: "Refresh",
    refreshing: "Refreshing...",
    clear: "Clear",
    showArchived: "Show archived sessions",
    search: "Search",
    searchPlaceholder: "Search session content...",
    provider: "Provider",
    date: "Date",
    cwd: "Working Directory",
    all: "All",
    sortDesc: "Newest first",
    listHint: "Select a session to view details",
    listAriaLabel: "Session list",
    tabsAriaLabel: "Detail view tabs",
    selectSession: "Select a Session",
    selectSessionDesc: "All parsed sessions are shown on the left. Once selected, the right panel will display the summary, conversation view, and raw event stream.",
    eyebrowDetail: "SESSION DETAIL",
    tabConversation: "Conversation",
    tabRaw: "Raw Events",
    exportMd: "Export as Markdown",
    exportJson: "Export as JSON",
    providerLabel: "Provider",
    startTime: "Start Time",
    lastTime: "Last Time",
    source: "Source",
    originator: "Originator",
    cwdLabel: "Working Directory",
    eventCount: "Event Count",
    sessionId: "Session ID",
    filePath: "File Path",
    noConversations: "This session has no structured conversation messages. Switch to the Raw Events tab.",
    copyMessage: "Copy message content",
    copy: "Copy",
    copied: "✓",
    copyFailed: "Failed",
    linePrefix: "Line {n}",
    loadMore: "Load more",
    loadingMore: "Loading...",
    noResults: "No sessions match the current filters.",
    noWorkDir: "No working directory recorded",
    loadDetailFailed: "Failed to load session details",
    loadListFailed: "Failed to load session list",
    loadMoreFailed: "Failed to load more",
    refreshFailed: "Refresh failed",
    searchFailed: "Search failed",
    statsRecentDaily: "Recent daily sessions",
    statsCommonProvider: "Common Provider",
    statsCommonCwd: "Common Working Directory",
    unknownTime: "Unknown time",
    noCwd: "(no working directory)",
    eventsCount: "{n} events",
    unknownSource: "Unknown source",
    unarchive: "Unarchive",
    archive: "Archive this session",
    newSessionAdded: "New session added",
    session: "Session",
    requestFailed: "Request failed: {status}",
    errorUnknown: "Unknown error",
    forbidden: "Forbidden",
    notFound: "Page not found",
    methodNotAllowed: "Only GET is supported",
    badRequest: "Bad request",
    missingQuery: "Missing search query",
    invalidSessionId: "Invalid session ID",
    sessionNotFound: "Session not found",
    serverError: "Internal server error",
  },
};

let currentLang = localStorage.getItem(LANG_KEY) || "zh";

export function t(key, vars = {}) {
  const str = DICT[currentLang]?.[key] ?? DICT.zh[key] ?? key;
  return str.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

export function setLang(lang) {
  currentLang = lang;
  localStorage.setItem(LANG_KEY, lang);
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  updateStaticI18n();
}

export function getLang() {
  return currentLang;
}

export function updateStaticI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (!key) return;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      el.placeholder = t(key);
    } else if (el.tagName === "OPTION") {
      el.textContent = t(key);
    } else {
      el.textContent = t(key);
    }
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.dataset.i18nPlaceholder;
    if (key) el.placeholder = t(key);
  });
  document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    const attr = el.dataset.i18nAttr;
    const key = el.dataset.i18n;
    if (attr && key) el.setAttribute(attr, t(key));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (key) el.title = t(key);
  });
  const titleEl = document.querySelector("[data-i18n-page-title]");
  if (titleEl) {
    document.title = t(titleEl.dataset.i18nPageTitle);
  }
}
