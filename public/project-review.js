import { t } from "./i18n.js";
import { displaySessionTitle, formatListTimestamp } from "./session-format.js";

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
    ["recent", "projectRecentSessions"],
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
    const list = document.createElement("ul");
    list.className = "project-review-list";
    for (const session of sessions) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stats-activity-link";
      button.textContent = displaySessionTitle(session) || session.key;
      button.disabled = !onSelectSession;
      button.addEventListener("click", () => onSelectSession?.(session.key));
      const meta = document.createElement("p");
      meta.className = "project-review-meta";
      meta.textContent = [
        session.source,
        formatListTimestamp(session.timestamp),
        session.favorite ? t("favorite") : "",
        ...(session.tags || []),
      ]
        .filter(Boolean)
        .join(" · ");
      item.append(button, meta);
      if (session.note) {
        const note = document.createElement("p");
        note.className = "project-review-note";
        note.textContent = session.note;
        item.append(note);
      }
      list.append(item);
    }
    section.append(list);
    columns.append(section);
  }
  container.append(columns);
}
