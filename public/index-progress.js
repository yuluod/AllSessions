export function createIndexProgressPoller({
  read,
  render,
  onError,
  isVisible,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let timer;
  let running = false;
  let refreshPending = false;

  async function refresh() {
    cancel(timer);
    timer = undefined;
    if (!isVisible()) {
      refreshPending = false;
      return;
    }
    if (running) {
      refreshPending = true;
      return;
    }
    running = true;
    let active = false;
    try {
      const status = await read();
      active = ["scanning", "indexing"].includes(status.phase);
      if (isVisible()) render(status);
    } catch (error) {
      if (isVisible()) onError(error);
    } finally {
      running = false;
      if (isVisible() && (refreshPending || active)) {
        timer = schedule(refresh, refreshPending ? 0 : 1000);
      }
      refreshPending = false;
    }
  }

  return { refresh };
}
