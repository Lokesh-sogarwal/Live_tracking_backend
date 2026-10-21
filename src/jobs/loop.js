// Repeats fn every `everyMs` using a setTimeout chain, so a slow run never overlaps the
// next. Holds a single pending timer (the previous worker loop appended every timer to an
// array that was never trimmed). Errors are reported and the loop continues.
export function startLoop(fn, everyMs, { shouldRun = () => true, onError = () => {} } = {}) {
  let timer = null;
  let stopped = false;

  const tick = async () => {
    timer = null;
    if (stopped) return;
    try {
      if (shouldRun()) await fn();
    } catch (err) {
      onError(err);
    }
    if (!stopped) timer = setTimeout(tick, everyMs);
  };
  timer = setTimeout(tick, 0);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get pending() {
      return timer !== null;
    },
  };
}
