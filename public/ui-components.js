export function bindPopoverMenus(root = document) {
  const menus = [...root.querySelectorAll("[data-popover]")];
  function closeOthers(current) {
    for (const menu of menus) {
      if (menu !== current) menu.open = false;
    }
  }
  for (const menu of menus) {
    menu.addEventListener("toggle", () => {
      if (menu.open) closeOthers(menu);
    });
  }
  root.addEventListener("click", (event) => {
    const current = menus.find((menu) => menu.contains(event.target));
    closeOthers(current);
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const current = menus.find((menu) => menu.open);
    if (!current) return;
    closeOthers(null);
    current.querySelector("summary")?.focus();
    event.preventDefault();
    event.stopPropagation();
  });
}

export function createEmptyState({ title, description = "", compact = false }) {
  const container = document.createElement("div");
  container.className = compact
    ? "ui-empty-state ui-empty-state--compact"
    : "ui-empty-state";
  container.setAttribute("role", "status");
  const heading = document.createElement("p");
  heading.className = "ui-empty-title";
  heading.textContent = title;
  container.append(heading);
  if (description) {
    const copy = document.createElement("p");
    copy.className = "ui-empty-description";
    copy.textContent = description;
    container.append(copy);
  }
  return container;
}
