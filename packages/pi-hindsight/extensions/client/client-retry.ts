export interface HindsightRestError extends Error {
  status?: number;
  body?: unknown;
}

export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status =
    (error as HindsightRestError).status ?? (error as { statusCode?: number }).statusCode;
  if (typeof status === "number" && status >= 500) return true;
  if (error.message.includes("timed out")) return true;
  if (error.message.includes("fetch failed")) return true;
  if (error.message.includes("ECONNREFUSED")) return true;
  if (error.message.includes("ENOTFOUND")) return true;
  if (error.message.includes("ETIMEDOUT")) return true;
  if (error.message.includes("ECONNRESET")) return true;
  return false;
}

export async function withRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const jitter = Math.random() * baseDelayMs * 0.5;
      const delay = baseDelayMs * 2 ** (attempt - 1) + jitter;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableError(error)) throw error;
      lastError = error as Error;
    }
  }
  throw lastError ?? new Error(`${operation} failed after retries`);
}
