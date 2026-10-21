// Repeats fn every `everyMs` using a setTimeout chain, so a slow run never overlaps the
// next. Holds a single pending timer (the previous worker loop appended every timer to an
// array that was never trimmed). Errors are reported and the loop continues; after
// consecutive failures (e.g. the database is unreachable) the wait grows exponentially, with
// jitter, up to maxBackoffMs, and returns to `everyMs` after the next success.
export function startLoop(fn, everyMs, { shouldRun = () => true, onError = () => {}, maxBackoffMs = 60_000, random = Math.random } = {}) {
  let timer = null;
  let stopped = false;
  let failures = 0;

  const nextDelay = () => {
    if (!failures) return everyMs;
    const base = Math.min(maxBackoffMs, everyMs * 2 ** Math.min(failures, 16));
    return Math.round(base * (0.8 + 0.4 * random())); // +-20 % jitter
  };

  const tick = async () => {
    timer = null;
    if (stopped) return;
    try {
      if (shouldRun()) await fn();
      failures = 0;
    } catch (err) {
      failures += 1;
      onError(err, { failures, retryInMs: nextDelay() });
    }
    if (!stopped) timer = setTimeout(tick, nextDelay());
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
    get failures() {
      return failures;
    },
  };
}
