/** Retries of a model request that failed before any of its output streamed. */
export interface RetryPolicy {
  /** Retries after the first attempt. Defaults to 4. */
  retries?: number;
  /** The first backoff delay, doubled on each retry. Defaults to 1000 ms. */
  baseMs?: number;
  /** The longest backoff delay and the longest Retry-After to wait for. Defaults to 30000 ms. */
  maxMs?: number;
  /** Resolves true after `ms`, false when `signal` aborts first. */
  sleep?(ms: number, signal: AbortSignal): Promise<boolean>;
}

export const sleep = (ms: number, signal: AbortSignal) => new Promise<boolean>((resolve) => {
  if (signal.aborted) return resolve(false);
  const abort = () => {
    clearTimeout(timer);
    resolve(false);
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", abort);
    resolve(true);
  }, ms);
  signal.addEventListener("abort", abort, { once: true });
});

export const DEFAULT_RETRY: Required<RetryPolicy> = { retries: 4, baseMs: 1000, maxMs: 30000, sleep };

const NETWORK = /network|connection|connect to|timed out|timeout|load failed|failed to fetch|fetch failed|offline|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|stream ended before the response finished/i;
const BUSY = /overloaded|rate.?limit/i;
const QUOTA = /insufficient_quota|exceeded your current quota|billing/i;

const header = (headers: unknown, name: string): string | undefined => {
  if (!headers || typeof headers !== "object") return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === "string" ? entry[1] : undefined;
};

/** Milliseconds from `retryAfterMs`, a `retryAfter` value in seconds, or `retry-after-ms` and `retry-after` headers. */
export function retryAfterMs(error: unknown): number | undefined {
  const value = (error ?? {}) as { retryAfterMs?: unknown; retryAfter?: unknown; headers?: unknown };
  if (typeof value.retryAfterMs === "number" && value.retryAfterMs >= 0) return value.retryAfterMs;
  const ms = header(value.headers, "retry-after-ms");
  if (ms?.trim() && Number(ms) >= 0) return Number(ms);
  const raw = value.retryAfter ?? header(value.headers, "retry-after");
  if (typeof raw === "number") return raw >= 0 ? raw * 1000 : undefined;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** HTTP 408, 409, 429 and 5xx other than 501 and 505, an overloaded or rate limit message, or a network failure without a status. */
export function isTransient(error: unknown) {
  const { status, body } = (error ?? {}) as { status?: unknown; body?: unknown };
  const message = error instanceof Error ? error.message : String(error);
  const text = `${typeof body === "string" ? body : ""} ${message}`;
  if (QUOTA.test(text)) return false;
  if (typeof status === "number")
    return status === 408 || status === 409 || status === 429 || (status >= 500 && status !== 501 && status !== 505) || BUSY.test(text);
  return BUSY.test(message) || NETWORK.test(message) || (error instanceof TypeError && /fetch|load/i.test(message));
}

/** The wait before retry number `attempt + 1`, or undefined to give up. A Retry-After above `maxMs` gives up. */
export function retryDelay(error: unknown, attempt: number, policy: Required<RetryPolicy>) {
  if (attempt >= policy.retries || !isTransient(error)) return undefined;
  const after = retryAfterMs(error);
  if (after !== undefined) return after <= policy.maxMs ? after : undefined;
  return Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
}
