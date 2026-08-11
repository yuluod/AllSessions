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
          return generation === requestGeneration &&
            controller === requestController &&
            !requestController.signal.aborted;
        }
      };
    },

    cancel() {
      generation += 1;
      controller?.abort();
      controller = null;
    }
  };
}

export function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}
