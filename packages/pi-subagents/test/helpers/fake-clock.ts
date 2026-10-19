import { vi } from "vitest";

/**
 * Replaces only the clock APIs the mailbox and the manager schedule with, so their poll loops and
 * countdowns are driven by the test instead of the wall clock. `setImmediate` stays real: `turn`
 * below is one honest event-loop turn, which lets already-started promise chains and pending I/O
 * finish without waiting for any real time to pass.
 */
export function useFakeClock(): void {
	vi.useFakeTimers({
		toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"],
	});
}

export function useRealClock(): void {
	vi.useRealTimers();
}

/** One real event-loop turn: everything already queued has run by the time this resolves. */
export function turn(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

/**
 * Advances the fake clock by `ms`, then lets the promise chains those timers started finish, so the
 * next assertion sees the settled effect of the fake time that passed.
 */
export async function advanceFakeTime(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	for (let index = 0; index < 8; index += 1) await turn();
}

/**
 * Resolves `work` once it settles, advancing the fake clock only while it has to. The bound is the
 * completion of `work` itself — an event promise or an awaited exchange, never an assertion retry —
 * and the tick budget fails fast instead of hanging the test when it never arrives.
 */
export async function until<T>(work: Promise<T>, stepMs = 1_000, maxTicks = 100): Promise<T> {
	let settled = false;
	const guarded = work.finally(() => {
		settled = true;
	});
	void guarded.catch(() => {});
	for (let tick = 0; tick < maxTicks && !settled; tick += 1) {
		for (let index = 0; index < 8; index += 1) await turn();
		if (settled) break;
		await vi.advanceTimersByTimeAsync(stepMs);
	}
	if (!settled) throw new Error(`the awaited exchange did not settle within ${maxTicks} ticks`);
	return guarded;
}
