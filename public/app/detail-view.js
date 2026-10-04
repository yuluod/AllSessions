// 详情视图:标签行、属性面板、信息抽屉、原始事件与详情占位。
import { t } from "../i18n.js";
import { formatTimestamp, providerLabel } from "../session-format.js";
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
import { conversationView } from "./controllers.js";

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
export function createTagIcon(icon) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");

  const add = (name, attributes) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) =>
      node.setAttribute(key, value)
    );
    svg.append(node);
  };

  if (icon === "calendar") {
    add("rect", {
      x: "3",
      y: "4",
      width: "18",
      height: "18",
      rx: "2",
      ry: "2",
    });
    add("line", { x1: "16", y1: "2", x2: "16", y2: "6" });
    add("line", { x1: "8", y1: "2", x2: "8", y2: "6" });
    add("line", { x1: "3", y1: "10", x2: "21", y2: "10" });
  } else if (icon === "hash") {
    add("line", { x1: "4", y1: "9", x2: "20", y2: "9" });
    add("line", { x1: "4", y1: "15", x2: "20", y2: "15" });
    add("line", { x1: "10", y1: "3", x2: "8", y2: "21" });
    add("line", { x1: "16", y1: "3", x2: "14", y2: "21" });
  }

  return svg;
}

export function renderDetailTags(summary) {
  elements.detailTags.innerHTML = "";
  const workspace = sessionWorkspace(summary);
  const tags = [
    {
      text: formatTimestamp(summary.timestamp),
      icon: "calendar",
      cls: "tag-time",
    },
    { text: providerLabel(summary), cls: "tag-provider" },
    {
      text: displaySourceLabel(summary),
      cls: "tag-source",
      sourceKind: sourceKindValue(summary),
    },
    { text: hiddenReasonLabel(summary), cls: "tag-hidden" },
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
    if (icon) {
      span.append(createTagIcon(icon), document.createTextNode(` ${text}`));
    } else {
      span.append(document.createTextNode(text));
    }
    elements.detailTags.append(span);
  });

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
export function renderPropsPanel(summary, messages = []) {
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
  elements.propsContent.append(
    section(t("basicInfo"), basic),
    section(t("techInfo"), tech),
    conversationView.createMessageNavSection(messages)
  );
}

export function setPropsPlaceholder(message) {
  if (!elements.propsContent) return;
  const placeholder = document.createElement("div");
  placeholder.className = "props-empty";
  placeholder.textContent = message;
  elements.propsContent.replaceChildren(placeholder);
}

export function setInspectorOpen(open) {
  const panel = elements.propsContent?.closest(".props-panel");
  const drawerLayout = window.matchMedia(INSPECTOR_DRAWER_QUERY).matches;
  const isOpen = Boolean(drawerLayout && open && state.currentDetail);
  panel?.classList.toggle("is-open", isOpen);
  panel?.setAttribute(
    "aria-hidden",
    !drawerLayout || isOpen ? "false" : "true"
  );
  elements.sessionInspectorToggle?.setAttribute(
    "aria-expanded",
    isOpen ? "true" : "false"
  );
}

export function syncInspectorLayout() {
  const panel = elements.propsContent?.closest(".props-panel");
  setInspectorOpen(panel?.classList.contains("is-open") === true);
}

export function syncRoleFilterButtons() {
  document
    .querySelectorAll("#role-filter .role-filter-btn")
    .forEach((button) => {
      const active = button.dataset.role === state.roleFilter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
}

export function setRawEventCardCollapsed(card, toggleButton, collapsed) {
  card.classList.toggle("collapsed", collapsed);
  toggleButton.textContent = collapsed ? "▶" : "▼";
  toggleButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
  const label = collapsed ? t("expandRawEvent") : t("collapseRawEvent");
  toggleButton.title = label;
  toggleButton.setAttribute("aria-label", label);
}

export function renderRawEvents(events) {
  elements.rawEvents.innerHTML = "";

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
export function setDetailPlaceholder(title, description = "") {
  const heading = document.createElement("h2");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = description;
  copy.classList.toggle("hidden", !description);
  elements.detailEmpty.replaceChildren(heading, copy);
}
export function showSelectSessionPlaceholder() {
  detailRequestGate.cancel();
  elements.detailView.classList.add("hidden");
  elements.detailEmpty.classList.remove("hidden");
  setDetailPlaceholder(t("selectSession"), t("selectSessionDesc"));
  setPropsPlaceholder(t("selectSession"));
}
