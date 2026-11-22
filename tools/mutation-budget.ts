export function mutationBudget(
  milliseconds = Infinity,
  now: () => number = () => performance.now(),
) {
  const controller = new AbortController();
  const deadline = now() + milliseconds;
  function expire() {
    controller.abort(new Error("budget-exhausted"));
  }

  const timer = Number.isFinite(milliseconds) ? setTimeout(expire, milliseconds) : undefined;
  return {
    signal: controller.signal,
    check() {
      if (now() >= deadline) expire();
      controller.signal.throwIfAborted();
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
