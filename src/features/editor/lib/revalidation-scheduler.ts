/** Coalesce disk reads without starving an editor during continuous file writes. */
export function createRevalidationScheduler(run: () => void, delayMs = 150, maxWaitMs = 1000) {
  let trailing: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(trailing);
    clearTimeout(deadline);
    trailing = undefined;
    deadline = undefined;
  };
  const flush = () => {
    cancel();
    run();
  };
  return {
    schedule() {
      clearTimeout(trailing);
      trailing = setTimeout(flush, delayMs);
      deadline ??= setTimeout(flush, maxWaitMs);
    },
    flush,
    cancel,
  };
}
