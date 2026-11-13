// 详情视图:标签行、属性面板、信息抽屉、原始事件与详情占位。
import { t } from "../i18n.js";
import { syncPaneLayout } from "../pane-layout.js";
import { roleCounts } from "../conversation-filter.js";
import { modelUsage } from "../session-insights.js";
import {
  displaySessionTitle,
  formatCount,
  formatTimestamp,
  formatTokensCompact,
  isSessionRunning,
  providerLabel,
} from "../session-format.js";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  INSPECTOR_DRAWER_QUERY,
  announce,
  detailRequestGate,
  displaySourceLabel,
  elements,
  fetchJson,
  hiddenReasonLabel,
  resumeCommandForKind,
  sessionWorkspace,
  showError,
  sourceKindValue,
  state,
  visibilityLabel,
} from "./shared.js";
import { createIcon } from "./icons.js";
import { handoffController } from "./controllers.js";

export function parseWorkspaceTags(value) {
  return Array.from(
    new Set(
      value
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

// 详情标题统一入口：自定义名称 > 原始标题 > 工作目录尾段。
export function syncDetailTitle(summary) {
  const fullCwd = summary?.cwd || t("noWorkDir");
  elements.detailTitle.textContent =
    displaySessionTitle(summary) || fullCwd.split(/[\\/]/).pop() || fullCwd;
  elements.detailTitle.title = summary?.cwd
    ? `${fullCwd}\n${t("renameSessionHint")}`
    : fullCwd;
}

export function syncSessionWorkspaceControls(summary) {
  const workspace = sessionWorkspace(summary);
  const favorite = workspace.favorite === true;
  elements.sessionFavoriteBtn?.setAttribute(
    "aria-pressed",
    favorite ? "true" : "false"
  );
  const favoriteText = t(favorite ? "unfavorite" : "favorite");
  elements.sessionFavoriteBtn?.setAttribute("aria-label", favoriteText);
  elements.sessionFavoriteBtn?.setAttribute("title", favoriteText);
  if (elements.sessionNameInput) {
    elements.sessionNameInput.value = workspace.display_name || "";
    elements.sessionNameInput.placeholder =
      summary.title || t("workspaceDisplayNamePlaceholder");
  }
  if (elements.sessionTagsInput) {
    elements.sessionTagsInput.value = (workspace.tags || []).join(", ");
  }
  if (elements.sessionNoteInput) {
    elements.sessionNoteInput.value = workspace.note || "";
  }
  if (elements.revealSourceBtn) {
    elements.revealSourceBtn.disabled = !summary.file_path;
  }
  if (elements.revealProjectBtn) {
    elements.revealProjectBtn.disabled = !summary.cwd;
  }
  if (elements.resumeSessionBtn) {
    elements.resumeSessionBtn.disabled =
      !summary.id ||
      !resumeCommandForKind(sourceKindValue(summary), summary.id);
  }
}

export async function resumeCurrentSession() {
  const summary = state.currentDetail?.summary;
  const sessionKey = summary?._key;
  if (!sessionKey || !elements.resumeSessionBtn) return;
  elements.resumeSessionBtn.disabled = true;
  try {
    const result = await fetchJson("/api/sessions/resume", {
      method: "POST",
      body: { sessionKey },
    });
    announce(t("resumeLaunched", { command: result.command || "" }));
  } catch (error) {
    showError(`${t("resumeFailed")}: ${error.message || error}`);
  } finally {
    elements.resumeSessionBtn.disabled = false;
  }
}

export async function revealCurrentPath(kind) {
  const summary = state.currentDetail?.summary;
  const path = kind === "source" ? summary?.file_path : summary?.cwd;
  if (!path) return;
  try {
    await revealItemInDir(path);
  } catch (error) {
    showError(`${t("revealFailed")}: ${error.message || error}`);
  }
}
const TAG_ICONS = { calendar: "calendar-blank", hash: "hash" };

export function createTagIcon(icon) {
  return createIcon(TAG_ICONS[icon] || icon, { size: 12 });
}

export function renderDetailTags(summary) {
  elements.detailTags.innerHTML = "";
  const workspace = sessionWorkspace(summary);
  const tags = [
    {
      text: displaySourceLabel(summary),
      cls: "tag-source",
      sourceKind: sourceKindValue(summary),
    },
    { text: providerLabel(summary), cls: "tag-provider" },
    {
      text: modelUsage(summary.usage)
        .map((model) => model.name)
        .filter(Boolean)
        .join(" · "),
      cls: "tag-model",
    },
    {
      text: formatTimestamp(summary.timestamp),
      icon: "calendar",
      cls: "tag-time",
    },
    { text: hiddenReasonLabel(summary), cls: "tag-hidden" },
    {
      text: isSessionRunning(summary) ? t("sessionRunning") : "",
      cls: "tag-running",
    },
    {
      text: workspace.removed === true ? t("removedSession") : "",
      cls: "tag-removed",
    },
    {
      text: workspace.favorite === true ? t("favorite") : "",
      cls: "tag-favorite",
    },
    {
      text: summary.detail_truncated ? t("partialDetail") : "",
      cls: "tag-hidden",
    },
  ];

  tags.forEach(({ text, cls, icon, sourceKind }) => {
    if (!text) return;
    const span = document.createElement("span");
    span.className = `detail-tag ${cls || ""}`.trim();
    if (sourceKind) span.dataset.sourceKind = sourceKind;
    span.title = text;
    if (icon) {
      span.append(createTagIcon(icon), document.createTextNode(` ${text}`));
    } else {
      span.append(document.createTextNode(text));
    }
    elements.detailTags.append(span);
  });

  if (summary.cwd) {
    const cwd = document.createElement("span");
    cwd.className = "detail-tag tag-cwd";
    cwd.textContent = summary.cwd;
    cwd.title = `${t("cwdLabel")}: ${summary.cwd}`;
    elements.detailTags.append(cwd);
  }

  if (summary.id) {
    const shortId = summary.id.length > 8 ? summary.id.slice(0, 8) : summary.id;
    const kind = sourceKindValue(summary);
    const resumeCmd = resumeCommandForKind(kind, summary.id);
    const idTag = document.createElement("button");
    idTag.type = "button";
    idTag.className = "detail-tag tag-session-id";
    idTag.title = resumeCmd
      ? `${resumeCmd}\n${t("copy")}`
      : `${t("sessionId")}: ${summary.id}\n${t("copy")}`;
    idTag.textContent = `ID: ${shortId}`;
    idTag.addEventListener("click", () => {
      const copyText = resumeCmd || summary.id;
      navigator.clipboard.writeText(copyText).then(() => {
        const orig = idTag.textContent;
        idTag.textContent = t("copied");
        setTimeout(() => {
          idTag.textContent = orig;
        }, 1500);
      });
    });
    elements.detailTags.append(idTag);
  }
  (workspace.tags || []).slice(0, 3).forEach((tag) => {
    const span = document.createElement("span");
    span.className = "detail-tag tag-workspace";
    span.textContent = tag;
    elements.detailTags.append(span);
  });
  if ((workspace.tags || []).length > 3) {
    const span = document.createElement("span");
    span.className = "detail-tag tag-workspace";
    span.textContent = `+${workspace.tags.length - 3}`;
    elements.detailTags.append(span);
  }
}

export function syncSessionDeleteButton() {
  if (!elements.sessionDeleteBtn) return;
  const key = state.currentDetail?.summary?._key;
  const removed = key && sessionWorkspace(key).removed === true;
  elements.sessionDeleteBtn.textContent = t(
    removed ? "manageRemovedSession" : "deleteSession"
  );
}

export function syncSessionArchiveButton() {
  if (!elements.sessionArchiveBtn) return;
  const key = state.currentDetail?.summary?._key;
  const archived = key && sessionWorkspace(key).archived === true;
  elements.sessionArchiveBtn.textContent = t(
    archived ? "unarchive" : "archive"
  );
}
// ── 属性面板 ────────────────────────────────────────────────────────────────────
export function renderPropsPanel(summary) {
  const basic = [
    { label: "Provider", value: providerLabel(summary) },
    { label: t("source"), value: displaySourceLabel(summary) || "-" },
    { label: t("visibility"), value: visibilityLabel(summary) },
    { label: t("messages"), value: String(summary.message_count || 0) },
    { label: t("systemContext"), value: String(summary.context_count || 0) },
    { label: t("toolCalls"), value: String(summary.tool_count || 0) },
  ];
  const tech = [
    { label: t("sessionId"), value: summary.id, copyable: true },
    { label: t("filePath"), value: summary.file_path, copyable: true },
    { label: t("cwdLabel"), value: summary.cwd || "-", copyable: true },
  ];

  function section(title, rows) {
    const wrap = document.createElement("div");
    wrap.className = "props-section";
    const h3 = document.createElement("h3");
    h3.textContent = title;
    wrap.append(h3);
    const dl = document.createElement("dl");
    rows.forEach(({ label, value, copyable }) => {
      const row = document.createElement("div");
      row.className = "prop-row";
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      const valSpan = document.createElement("span");
      valSpan.className = "prop-value";
      valSpan.textContent = value || "-";
      valSpan.title = value || "";
      dd.append(valSpan);
      if (copyable && value) {
        const btn = document.createElement("button");
        btn.className = "prop-copy";
        btn.textContent = t("copy");
        btn.addEventListener("click", () => {
          navigator.clipboard.writeText(value).then(() => {
            btn.textContent = t("copied");
            setTimeout(() => {
              btn.textContent = t("copy");
            }, 1500);
          });
        });
        dd.append(btn);
      }
      row.append(dt, dd);
      dl.append(row);
    });
    wrap.append(dl);
    return wrap;
  }

  elements.propsContent.innerHTML = "";
  elements.propsContent.append(section(t("basicInfo"), basic));
  const models = modelUsage(summary.usage);
  if (models.length) {
    const totalTokens = models.reduce((sum, model) => sum + model.tokens, 0);
    const wrap = document.createElement("div");
    wrap.className = "props-section";
    const h3 = document.createElement("h3");
    h3.textContent = t("sessionModels");
    const list = document.createElement("div");
    list.className = "session-model-list session-model-list--panel";
    for (const model of models) {
      const label = model.name || t("sessionModelsUnknown");
      const row = document.createElement("div");
      row.className = "session-model-row";
      const name = document.createElement("span");
      name.className = "session-model-name";
      name.title = label;
      name.textContent = label;
      const track = document.createElement("span");
      track.className = "session-model-track";
      const fill = document.createElement("span");
      fill.className = "session-model-fill";
      fill.style.width = `${Math.max(
        2,
        Math.round((model.tokens / totalTokens) * 100)
      )}%`;
      fill.title = `${label} · ${formatCount(model.tokens)} Token`;
      track.append(fill);
      const count = document.createElement("span");
      count.className = "session-model-count";
      count.textContent = formatTokensCompact(model.tokens);
      count.title = `${formatCount(model.tokens)} Token`;
      row.append(name, track, count);
      list.append(row);
    }
    wrap.append(h3, list);
    elements.propsContent.append(wrap);
  }
  elements.propsContent.append(section(t("techInfo"), tech));
}

export function setPropsPlaceholder(message) {
  if (!elements.propsContent) return;
  const placeholder = document.createElement("div");
  placeholder.className = "props-empty";
  placeholder.textContent = message;
  elements.propsContent.replaceChildren(placeholder);
}

// 停靠栏默认展开，浮动抽屉默认关闭；两种布局的选择互不覆盖。
let dockedInspectorOpen = true;
let drawerInspectorOpen = false;

export function setInspectorOpen(open) {
  if (window.matchMedia(INSPECTOR_DRAWER_QUERY).matches) {
    drawerInspectorOpen = Boolean(open && state.currentDetail);
  } else {
    dockedInspectorOpen = Boolean(open);
  }
  syncInspectorLayout();
}

export function closeInspectorDrawer() {
  drawerInspectorOpen = false;
  syncInspectorLayout();
}

export function syncInspectorLayout() {
  const panel = elements.propsContent?.closest(".props-panel");
  const drawerLayout = window.matchMedia(INSPECTOR_DRAWER_QUERY).matches;
  const isOpen = drawerLayout
    ? Boolean(drawerInspectorOpen && state.currentDetail)
    : dockedInspectorOpen;
  panel?.classList.toggle("is-open", isOpen);
  panel?.setAttribute("aria-hidden", isOpen ? "false" : "true");
  elements.appLayout?.classList.toggle(
    "inspector-collapsed",
    !dockedInspectorOpen
  );
  syncPaneLayout();
  elements.sessionInspectorToggle?.setAttribute(
    "aria-expanded",
    isOpen ? "true" : "false"
  );
  if (!isOpen && panel?.contains(document.activeElement)) {
    elements.sessionInspectorToggle?.focus();
  }
}

export function syncRoleFilterButtons() {
  const counts = roleCounts(state.currentDetail?.conversation_messages || []);
  document
    .querySelectorAll("#role-filter .role-filter-btn")
    .forEach((button) => {
      const role = button.dataset.role;
      // 只保留当前会话实际存在的角色，避免点进必然为空的筛选。
      const available = !role || (counts.get(role) || 0) > 0;
      button.classList.toggle("hidden", !available);
      button.disabled = !available;
      const active = role === state.roleFilter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
}

export function setRawEventCardCollapsed(card, toggleButton, collapsed) {
  card.classList.toggle("collapsed", collapsed);
  toggleButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
  const label = collapsed ? t("expandRawEvent") : t("collapseRawEvent");
  toggleButton.title = label;
  toggleButton.setAttribute("aria-label", label);
}

let pendingRawEvents = [];
let rawEventsDirty = false;
export function renderRawEvents(events) {
  pendingRawEvents = events;
  rawEventsDirty = true;
  if (state.activeTab !== "raw") return;
  rawEventsDirty = false;
  elements.rawEvents.innerHTML = "";

  if (!events.length) {
    const empty = document.createElement("p");
    empty.className = "hero-copy";
    empty.textContent = t("noRawEvents");
    elements.rawEvents.append(empty);
    return;
  }

  events.forEach((event, idx) => {
    const fragment = elements.rawEventTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".raw-event-card");
    fragment.querySelector(".raw-event-idx").textContent = `#${idx + 1}`;
    fragment.querySelector(".raw-event-type").textContent = event.type;
    fragment.querySelector(".raw-event-time").textContent = formatTimestamp(
      event.timestamp
    );
    fragment.querySelector(".raw-event-line").textContent = t("linePrefix", {
      n: event.line_number,
    });
    const payload = fragment.querySelector(".raw-event-payload");
    payload.textContent = JSON.stringify(event.payload, null, 2);
    payload.id = `raw-event-payload-${idx + 1}`;
    const toggleBtn = fragment.querySelector(".raw-event-toggle");
    toggleBtn.setAttribute("aria-controls", payload.id);
    setRawEventCardCollapsed(card, toggleBtn, true);
    toggleBtn.addEventListener("click", () => {
      setRawEventCardCollapsed(
        card,
        toggleBtn,
        !card.classList.contains("collapsed")
      );
    });
    elements.rawEvents.append(fragment);
  });
}

export function updateTabs() {
  elements.tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === state.activeTab;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
    button.tabIndex = isActive ? 0 : -1;
  });
  const conversationActive = state.activeTab === "conversation";
  if (!conversationActive && rawEventsDirty) renderRawEvents(pendingRawEvents);
  elements.conversationTab.classList.toggle("hidden", !conversationActive);
  elements.conversationTab.setAttribute(
    "aria-hidden",
    conversationActive ? "false" : "true"
  );
  elements.rawTab.classList.toggle("hidden", conversationActive);
  elements.rawTab.setAttribute(
    "aria-hidden",
    conversationActive ? "true" : "false"
  );
}
export function setDetailPlaceholder(
  title,
  description = "",
  showActions = false
) {
  const heading = elements.detailEmpty.querySelector("h2");
  heading.textContent = title;
  const copy = elements.detailEmpty.querySelector("p");
  copy.textContent = description;
  copy.classList.toggle("hidden", !description);
  elements.detailEmpty
    .querySelectorAll(".empty-state-hints, .empty-state-actions")
    .forEach((element) => element.classList.toggle("hidden", !showActions));
}
export function showSelectSessionPlaceholder() {
  detailRequestGate.cancel();
  handoffController?.onDetailChanged();
  elements.detailView.classList.add("hidden");
  elements.detailEmpty.classList.remove("hidden");
  // 普通空态不保留失败场景注入的重试按钮。
  elements.detailEmpty.querySelector("#detail-retry-action")?.remove();
  setDetailPlaceholder(t("selectSession"), t("selectSessionDesc"), true);
  setPropsPlaceholder(t("selectSession"));
}
