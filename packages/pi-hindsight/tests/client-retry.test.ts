import { describe, expect, it, vi } from "vitest";
import { isRetryableError, withRetry } from "../extensions/client/client-retry.js";

function retryableError(status?: number, message?: string): Error & { status?: number } {
  const error = new Error(message ?? `Error ${status}`) as Error & { status?: number };
  if (status !== undefined) error.status = status;
  return error;
}

describe("Hindsight client retry", () => {
  it("succeeds on first attempt when the operation succeeds", async () => {
    const fn = vi.fn(async () => ({ ok: true }));
    const result = await withRetry("test", fn, 3, 10);
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx error and succeeds on second attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryableError(503))
      .mockResolvedValueOnce({ ok: true });
    const result = await withRetry("test", fn, 3, 10);
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("fails after max retries exhausted", async () => {
    const fn = vi.fn(async () => {
      throw retryableError(503);
    });
    await expect(withRetry("test", fn, 3, 10)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("does not retry on 4xx client error", async () => {
    const fn = vi.fn(async () => {
      throw retryableError(404);
    });
    await expect(withRetry("test", fn, 3, 10)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on network error (fetch failed)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryableError(undefined, "fetch failed"))
      .mockResolvedValueOnce({ ok: true });
    const result = await withRetry("test", fn, 3, 10);
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("classifies retryable transport failures", () => {
    expect(isRetryableError(retryableError(503))).toBe(true);
    expect(isRetryableError(retryableError(undefined, "ECONNRESET"))).toBe(true);
    expect(isRetryableError(retryableError(404))).toBe(false);
    expect(isRetryableError("not an error")).toBe(false);
  });
});
