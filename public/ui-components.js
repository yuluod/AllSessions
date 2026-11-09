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
  root.addEventListener("focusin", (event) => {
    closeOthers(menus.find((menu) => menu.contains(event.target)));
  });
  root.addEventListener("keydown", (event) => {
    // 方向键只在入口接管，不覆盖表单内光标、下拉框和复选框的原生操作。
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const menu = menus.find(
        (item) => item.querySelector("summary") === event.target
      );
      if (!menu) return;
      closeOthers(menu);
      menu.open = true;
      const controls = [
        ...menu.querySelectorAll(
          'button, a[href], input, select, textarea, [tabindex="0"]'
        ),
      ].filter(
        (control) =>
          !control.matches(":disabled") && control.getClientRects().length > 0
      );
      const target = event.key === "ArrowDown" ? controls[0] : controls.at(-1);
      target?.focus();
      event.preventDefault();
      return;
    }
    if (event.key !== "Escape") return;
    const current = menus.find((menu) => menu.open);
    if (!current) return;
    closeOthers(null);
    current.querySelector("summary")?.focus();
    event.preventDefault();
    event.stopPropagation();
  });
}

export function showDialogFromPopover(dialog, root = document) {
  const menu = root.activeElement?.closest?.("[data-popover]");
  if (menu) {
    // 原生弹窗记住当前焦点；先返回入口，关闭后就不会聚焦隐藏的菜单项。
    menu.open = false;
    menu.querySelector("summary")?.focus();
  }
  dialog.showModal();
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
