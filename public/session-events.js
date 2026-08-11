const EVENT_TYPES = ["session-added", "session-updated", "session-deleted"];

export function bindSessionEvents(eventSource, {
  refresh,
  onSessionAdded = () => {},
  onMalformed = () => {},
  onError = () => {},
  debounceMs = 120
}) {
  let timer = null;
  let disposed = false;

  const scheduleRefresh = () => {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      Promise.resolve()
        .then(() => refresh())
        .catch(onError);
    }, debounceMs);
  };

  const handlers = new Map(EVENT_TYPES.map((type) => {
    const handler = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (type === "session-added") onSessionAdded(payload);
      } catch (error) {
        onMalformed(error);
      }
      scheduleRefresh();
    };
    eventSource.addEventListener(type, handler);
    return [type, handler];
  }));

  return () => {
    disposed = true;
    clearTimeout(timer);
    for (const [type, handler] of handlers) {
      eventSource.removeEventListener(type, handler);
    }
  };
}
