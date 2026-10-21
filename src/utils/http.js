// Outbound HTTP with a hard timeout and bounded exponential backoff. Retries only on
// network errors, 429 and 5xx; 4xx responses are returned to the caller immediately.
export async function fetchWithRetry(url, { retries = 2, timeoutMs = 8000, baseDelayMs = 250, ...init } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Upstream responded ${res.status}`);
        lastErr.status = res.status;
      } else {
        return res;
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < retries) {
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * baseDelayMs);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
