// 尽量让点击反馈先绘制；窗口隐藏或动画帧暂停时不无限等待。
export function nextPaint() {
  return new Promise((resolve) => {
    if (
      typeof requestAnimationFrame !== "function" ||
      globalThis.document?.hidden
    ) {
      setTimeout(resolve, 0);
      return;
    }
    let frame;
    const finish = () => {
      clearTimeout(fallback);
      if (typeof cancelAnimationFrame === "function")
        cancelAnimationFrame(frame);
      resolve();
    };
    const fallback = setTimeout(finish, 100);
    frame = requestAnimationFrame(() => setTimeout(finish, 0));
  });
}

export function createLatestRequestGate() {
  let generation = 0;
  let controller = null;

  return {
    begin() {
      generation += 1;
      controller?.abort();
      controller = new AbortController();
      const requestGeneration = generation;
      const requestController = controller;
      return {
        signal: requestController.signal,
        isCurrent() {
          return (
            generation === requestGeneration &&
            controller === requestController &&
            !requestController.signal.aborted
          );
        },
      };
    },

    cancel() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
  };
}

export function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}

// 同一轮刷新共享 Promise；执行中收到变更最多补一轮，不并发重查。
export function createRefreshCoordinator(run) {
  let active = null;
  let pending = new Set();
  return function refresh(scopes = []) {
    scopes.forEach((scope) => pending.add(scope));
    if (!active) {
      active = Promise.resolve()
        .then(async () => {
          let failure;
          while (pending.size) {
            const batch = pending;
            pending = new Set();
            try {
              await run(batch);
            } catch (error) {
              failure = error;
            }
          }
          if (failure) throw failure;
        })
        .finally(() => {
          active = null;
          if (pending.size) return refresh([]);
        });
    }
    return active;
  };
}

export async function mapWithConcurrency(values, concurrency, mapper) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency 必须是正整数");
  }

  const results = new Array(values.length);
  let nextIndex = 0;
  let failed = false;
  let firstError;

  async function worker() {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failed) throw firstError;
  return results;
}
