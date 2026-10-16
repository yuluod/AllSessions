export function initReadingToolbar() {
  const panel = document.querySelector("#detail-panel");
  const toolbar = panel.querySelector(".conversation-toolbar");
  const title = panel.querySelector("#detail-title");
  const backTop = document.querySelector("#reading-back-top");
  function sync() {
    panel.classList.toggle("is-reading", panel.scrollTop > 0);
    backTop.classList.toggle(
      "hidden",
      panel.scrollTop < 160 || panel.clientHeight === 0
    );
    panel.style.setProperty(
      "--reading-title-height",
      `${title.offsetHeight + 8}px`
    );
    panel.style.setProperty(
      "--reading-toolbar-height",
      `${toolbar.offsetHeight}px`
    );
  }

  panel.addEventListener("scroll", sync, { passive: true });
  backTop.addEventListener("click", () => {
    panel.scrollTo({
      top: 0,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  });
  const observer = new ResizeObserver(sync);
  observer.observe(toolbar);
  observer.observe(title);
  observer.observe(panel);
  sync();
}
