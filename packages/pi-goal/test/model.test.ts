import { describe, expect, test } from "bun:test";
import type { GoalState } from "../src/model.js";
import {
	incrementContinuation,
	MAX_CONTINUATIONS,
	MAX_OBJECTIVE_LENGTH,
	MAX_SUMMARY_LENGTH,
	recordBlocked,
	recordComplete,
	restoreStored,
	safetyStop,
	startNew,
	suspend,
} from "../src/model.js";

const ids = (() => {
	let next = 0;
	return () => `goal-${++next}`;
})();

describe("goal model", () => {
	test("starts, replaces, suspends, and restores with fresh ids", () => {
		const started = startNew("  ship feature  ", ids);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		expect(started.state).toMatchObject({
			mode: "active",
			active: { goalId: "goal-1", objective: "ship feature" },
		});
		const suspended = suspend(started.state);
		expect(suspended).toMatchObject({
			ok: true,
			state: { mode: "inactive", stored: { objective: "ship feature", status: "suspended" } },
		});
		if (!suspended.ok) return;
		const restored = restoreStored(suspended.state.stored, ids);
		expect(restored).toMatchObject({
			ok: true,
			state: { mode: "active", active: { goalId: "goal-2", objective: "ship feature" } },
		});
	});

	test("records blocked evidence and complete clears resumable state", () => {
		const started = startNew("objective", ids);
		if (!started.ok) throw new Error(started.error);
		const blocked = recordBlocked(started.state, "  dependency unavailable  ");
		expect(blocked).toMatchObject({
			ok: true,
			state: { mode: "inactive", stored: { status: "blocked", summary: "dependency unavailable" } },
		});
		const complete = recordComplete(started.state, "done");
		expect(complete).toEqual({
			ok: true,
			state: { mode: "inactive" },
			durable: { kind: "complete", objective: "objective", summary: "done" },
		});
	});

	test("rejects malformed input without mutating source", () => {
		const initial = startNew("objective", ids);
		if (!initial.ok) throw new Error(initial.error);
		expect(startNew("  ", ids).ok).toBe(false);
		expect(recordBlocked(initial.state, " ")).toMatchObject({ ok: false, state: initial.state });
		expect(safetyStop(initial.state, 42)).toMatchObject({ ok: false, state: initial.state });
	});

	test("caps continuations at twenty", () => {
		const started = startNew("objective", ids);
		if (!started.ok) throw new Error(started.error);
		let state: GoalState = started.state;
		for (let index = 0; index < MAX_CONTINUATIONS; index++) {
			const next = incrementContinuation(state);
			expect(next.ok).toBe(true);
			if (!next.ok) return;
			state = next.state;
		}
		const capped = incrementContinuation(state);
		expect(capped).toMatchObject({
			ok: true,
			state: { mode: "inactive", stored: { status: "suspended" } },
		});
	});

	test("preserves blocked evidence through restore and suspend", () => {
		const restored = restoreStored(
			{ objective: " objective ", status: "blocked", summary: " dependency unavailable " },
			() => "restored-id",
		);
		expect(restored).toMatchObject({
			ok: true,
			state: {
				mode: "active",
				stored: { objective: "objective", status: "blocked", summary: "dependency unavailable" },
			},
			durable: {
				kind: "snapshot",
				status: "active",
				summary: "dependency unavailable",
			},
		});
		if (!restored.ok) return;
		expect(suspend(restored.state)).toMatchObject({
			ok: true,
			state: { stored: { status: "suspended", summary: "dependency unavailable" } },
		});
	});

	test("rejects objectives and summaries over durable limits", () => {
		expect(startNew("x".repeat(MAX_OBJECTIVE_LENGTH + 1), ids).ok).toBe(false);
		const started = startNew("objective", ids);
		if (!started.ok) throw new Error(started.error);
		expect(recordComplete(started.state, "x".repeat(MAX_SUMMARY_LENGTH + 1))).toMatchObject({
			ok: false,
			state: started.state,
		});
	});
});
