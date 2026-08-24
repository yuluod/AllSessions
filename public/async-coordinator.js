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
