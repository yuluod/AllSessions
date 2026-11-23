import { t } from "./i18n.js";
import {
  displaySessionTitle,
  formatListTimestamp,
  RUNNING_WINDOW_MS,
} from "./session-format.js";

// 每组默认展示条数；后端最多返回 50 条，其余按步长展开。
export const PROJECT_REVIEW_PAGE_SIZE = 8;

function isRecentActivity(timestamp, now) {
  const age = now - timestamp;
  return age >= 0 && age < RUNNING_WINDOW_MS;
}

export function expireProjectReviewActivity(container, now = Date.now()) {
  container
    ?.querySelectorAll("[data-project-last-activity]")
    .forEach((hint) => {
      if (!isRecentActivity(Number(hint.dataset.projectLastActivity), now)) {
        hint.remove();
      }
    });
}

export function renderProjectReview(review, container, onSelectSession) {
  if (!container) return;
  container.replaceChildren();
  container.classList.toggle("hidden", !review);
  if (!review) return;
  container.setAttribute("aria-label", t("projectReview"));
  const heading = document.createElement("h3");
  heading.textContent = t("projectReview");
  const path = document.createElement("p");
  path.className = "project-review-path";
  path.textContent = review.cwd;
  container.append(heading, path);
  const columns = document.createElement("div");
  columns.className = "stats-grid";
  for (const [key, title] of [
    ["recent", "projectTimeline"],
    ["saved", "projectSavedSessions"],
  ]) {
    const section = document.createElement("section");
    section.className = "stats-section";
    const label = document.createElement("h3");
    label.textContent = t(title);
    section.append(label);
    const sessions = review[key] || [];
    if (!sessions.length) {
      const empty = document.createElement("p");
      empty.className = "props-empty";
      empty.textContent = t(key === "saved" ? "projectNoSaved" : "noResults");
      section.append(empty);
    }
    const list = document.createElement(key === "recent" ? "ol" : "ul");
    list.className = "project-review-list";
    list.setAttribute("role", "list");
    const renderItem = (session) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stats-activity-link";
      button.textContent = displaySessionTitle(session) || session.key;
      button.disabled = !onSelectSession;
      button.addEventListener("click", () => onSelectSession?.(session.key));
      const meta = document.createElement("p");
      meta.className = "project-review-meta";
      const timestamp = Date.parse(session.timestamp);
      const time = document.createElement(
        Number.isFinite(timestamp) ? "time" : "span"
      );
      time.textContent = formatListTimestamp(session.timestamp);
      if (Number.isFinite(timestamp)) time.dateTime = session.timestamp;
      meta.append(session.source || t("unknownSource"), " · ", time);
      const details = [
        session.favorite && t("favorite"),
        ...(session.tags || []),
      ].filter(Boolean);
      if (details.length) meta.append(" · ", details.join(" · "));
      if (key === "recent" && isRecentActivity(timestamp, Date.now())) {
        const hint = document.createElement("span");
        hint.dataset.projectLastActivity = String(timestamp);
        hint.textContent = ` · ${t("projectRecentActivity")}`;
        meta.append(hint);
      }
      item.append(button, meta);
      if (session.note) {
        const note = document.createElement("p");
        note.className = "project-review-note";
        note.textContent = session.note;
        item.append(note);
      }
      list.append(item);
      return button;
    };
    let shown = Math.min(PROJECT_REVIEW_PAGE_SIZE, sessions.length);
    sessions.slice(0, shown).forEach(renderItem);
    section.append(list);
    if (sessions.length > shown) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "stats-activity-link project-review-more";
      const updateLabel = () => {
        more.textContent = t("projectReviewShowMore", {
          n: sessions.length - shown,
        });
      };
      updateLabel();
      more.addEventListener("click", () => {
        const next = Math.min(
          shown + PROJECT_REVIEW_PAGE_SIZE,
          sessions.length
        );
        const added = sessions.slice(shown, next).map(renderItem);
        shown = next;
        if (document.activeElement === more && onSelectSession)
          added[0].focus();
        if (shown >= sessions.length) more.remove();
        else updateLabel();
      });
      section.append(more);
    }
    columns.append(section);
  }
  container.append(columns);
}
