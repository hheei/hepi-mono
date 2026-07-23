import { describe, expect, test } from "bun:test";
import {
	appendPlanBoundary,
	decodePlanBoundary,
	planUrl,
	restorePlan,
} from "../src/persistence.js";

describe("plan persistence", () => {
	test("builds canonical file URL and fails safely", () => {
		expect(planUrl("/tmp/my session.json", "entry one")).toBe(
			"file:///tmp/my%20session.json#entry%20one",
		);
		expect(planUrl(undefined, "entry")).toBeUndefined();
		expect(planUrl("/tmp/session", "")).toBeUndefined();
	});

	test("strictly decodes boundaries and restores current branch artifact", () => {
		expect(
			decodePlanBoundary({ version: 1, phase: "plan", initialAskPending: false, extra: true }),
		).toBeUndefined();
		const entries = [
			{ id: "p1", type: "custom_message", customType: "pi-basics-plan", content: "# Plan" },
			{
				type: "custom",
				customType: "pi-basics-plan-mode",
				data: {
					version: 1,
					phase: "plan-refine",
					planEntryId: "p1",
					planUrl: "file:///tmp/s#p1",
					requestedAction: "continue",
					initialAskPending: false,
				},
			},
		];
		expect(restorePlan(entries)).toEqual({
			boundary: {
				version: 1,
				phase: "plan-refine",
				planEntryId: "p1",
				planUrl: "file:///tmp/s#p1",
				requestedAction: "continue",
				initialAskPending: false,
			},
			plan: "# Plan",
		});
	});

	test("malformed newest boundary fails closed", () => {
		const entries = [
			{
				type: "custom",
				customType: "pi-basics-plan-mode",
				data: {
					version: 1,
					phase: "plan",
					planUrl: "file:///tmp/s#p1",
					initialAskPending: false,
				},
			},
			{ type: "custom", customType: "pi-basics-plan-mode", data: { version: 99, phase: "plan" } },
		];
		expect(restorePlan(entries).boundary).toEqual({ version: 1, phase: "none" });
	});

	test("append validates before mutation", () => {
		const calls: unknown[][] = [];
		appendPlanBoundary(
			{ appendEntry: (...args: unknown[]) => calls.push(args) },
			{ version: 1, phase: "none" },
		);
		expect(calls).toEqual([["pi-basics-plan-mode", { version: 1, phase: "none" }]]);
	});
});
