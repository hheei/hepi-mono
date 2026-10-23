/** Pi host frame coalescing; extensions must not build their own window at this rate. */
export const HOST_FRAME_INTERVAL_MS = 16;

/** Streaming repaint window for paths that rebuild a whole snapshot per event. */
export const STREAM_REPAINT_INTERVAL_MS = 100;

/**
 * Decides *when* a caller rebuilds its snapshot; the caller still decides *what* it rebuilds.
 * The first request renders immediately so new output is never held back by the window, later
 * requests in the same window collapse into one trailing render, and the last state is never
 * dropped while the window is open.
 *
 * Disposal is a correctness requirement, not just hygiene: the result a caller returns is the
 * only authority for its finished state, so a repaint that outlives the execution would rewrite
 * a settled body.
 */
export interface RenderThrottle {
	/** Renders now when no window is open, otherwise records one trailing render. */
	request(): void;
	/**
	 * Renders a pending trailing update now. A caller that is about to publish its final state
	 * flushes first, so the last streaming snapshot is delivered instead of dropped; the pending
	 * flag clears, so the timer that would have done it has nothing left to do.
	 */
	flush(): void;
	/** Idempotent: clears the timer and drops the pending render. */
	dispose(): void;
}

export function createRenderThrottle(
	render: () => void,
	intervalMs: number = STREAM_REPAINT_INTERVAL_MS,
): RenderThrottle {
	if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
		throw new Error("Render throttle interval must be a positive safe integer");
	let timer: NodeJS.Timeout | undefined;
	let pending = false;
	let disposed = false;
	return {
		request(): void {
			if (disposed) return;
			if (timer !== undefined) {
				pending = true;
				return;
			}
			render();
			timer = setTimeout(() => {
				timer = undefined;
				if (!pending) return;
				pending = false;
				render();
			}, intervalMs);
			timer.unref?.();
		},
		flush(): void {
			if (disposed || !pending) return;
			pending = false;
			render();
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			pending = false;
			if (timer === undefined) return;
			clearTimeout(timer);
			timer = undefined;
		},
	};
}
