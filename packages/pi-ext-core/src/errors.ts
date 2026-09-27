/**
 * Error shaping for extension boundaries.
 *
 * Pi hands over caught values as `unknown`, and every extension needs the same
 * two answers: what to show the user, and how to signal "this was cancelled"
 * instead of "this failed". `abortError` deliberately names the error
 * `AbortError` (the shape Pi and Node use for cancelled work) so callers can
 * classify a cancellation without matching message text.
 */

/** Reads a display message out of an unknown caught value. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Shapes the cancellation error for an aborted operation. A reason that is
 * already an `AbortError` (for example a caller's own cancellation error) is
 * returned unchanged; Node's generic `DOMException` is replaced by our stable
 * message because it carries nothing beyond "aborted".
 */
export function abortError(reason?: unknown): Error {
	if (reason instanceof Error && reason.name === "AbortError" && !(reason instanceof DOMException))
		return reason;
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	return error;
}

/** Throws the signal's cancellation error when it has already fired. */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted !== true) return;
	throw abortError(signal.reason);
}
