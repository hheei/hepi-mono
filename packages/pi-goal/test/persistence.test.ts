import { describe, expect, test } from "bun:test";
import { appendGoalEntry, decodeGoalEntry, replayGoal } from "../src/persistence.js";

describe("goal persistence", () => {
	test("replays latest valid branch entry and normalizes active", () => {
		const entries = [
			{
				type: "custom",
				customType: "goal",
				data: { version: 1, kind: "snapshot", objective: "first", status: "suspended" },
			},
			{
				type: "custom",
				customType: "goal",
				data: { version: 1, kind: "snapshot", objective: "second", status: "active" },
			},
			{
				type: "custom",
				customType: "other",
				data: { version: 1, kind: "snapshot", objective: "ignored", status: "blocked" },
			},
		];
		expect(replayGoal(entries)).toEqual({
			mode: "inactive",
			stored: { objective: "second", status: "suspended" },
		});
	});

	test("completion clears slot and malformed entries do not", () => {
		const entries = [
			{
				type: "custom",
				customType: "goal",
				data: {
					version: 1,
					kind: "snapshot",
					objective: "keep",
					status: "blocked",
					summary: "blocked",
				},
			},
			{
				type: "custom",
				customType: "goal",
				data: { version: 99, kind: "complete", objective: "bad", summary: "bad" },
			},
		];
		let warnings = 0;
		expect(replayGoal(entries, () => warnings++)).toEqual({
			mode: "inactive",
			stored: { objective: "keep", status: "blocked", summary: "blocked" },
		});
		expect(warnings).toBe(1);
		entries.push({
			type: "custom",
			customType: "goal",
			data: { version: 1, kind: "complete", objective: "keep", summary: "done" },
		});
		expect(replayGoal(entries)).toEqual({ mode: "inactive" });
	});

	test("append validates before host mutation", () => {
		const calls: unknown[][] = [];
		const appender = { appendEntry: (...args: unknown[]) => calls.push(args) };
		appendGoalEntry(appender, { kind: "complete", objective: "objective", summary: "done" });
		expect(calls).toEqual([
			["goal", { version: 1, kind: "complete", objective: "objective", summary: "done" }],
		]);
		expect(
			decodeGoalEntry({
				version: 1,
				kind: "snapshot",
				objective: "x",
				status: "suspended",
				extra: true,
			}),
		).toBeUndefined();
		expect(
			decodeGoalEntry({
				version: 1,
				kind: "snapshot",
				objective: "x".repeat(2_001),
				status: "suspended",
			}),
		).toBeUndefined();
	});
});
