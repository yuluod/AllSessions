const EVENT_TYPES = ["session-added", "session-updated", "session-deleted"];

export function bindSessionEvents(
  eventSource,
  {
    refresh,
    onSessionAdded = () => {},
    onMalformed = () => {},
    onError = () => {},
    debounceMs = 120,
  }
) {
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

  const handlers = new Map(
    EVENT_TYPES.map((type) => {
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
    })
  );

  return () => {
    disposed = true;
    clearTimeout(timer);
    for (const [type, handler] of handlers) {
      eventSource.removeEventListener(type, handler);
    }
  };
}

export async function bindTauriSessionEvents(options) {
  const listeners = new Map(EVENT_TYPES.map((type) => [type, new Set()]));
  const bridge = {
    addEventListener(type, handler) {
      listeners.get(type)?.add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
  };
  const disposeBinding = bindSessionEvents(bridge, options);
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") {
    disposeBinding();
    throw new Error("Tauri 事件接口不可用");
  }
  const unlisten = await listen("sessions-changed", (event) => {
    const payload =
      event.payload && typeof event.payload === "object" ? event.payload : {};
    const type = EVENT_TYPES.includes(payload.type)
      ? payload.type
      : "session-updated";
    const data = JSON.stringify(payload.summary || payload);
    for (const handler of listeners.get(type) || []) {
      handler({ data });
    }
  });
  return () => {
    disposeBinding();
    unlisten();
  };
}
