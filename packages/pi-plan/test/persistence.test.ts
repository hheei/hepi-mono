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

	test("restores durable plan after a none boundary", () => {
		const entries = [
			{ id: "p1", type: "custom_message", customType: "pi-basics-plan", content: "# Plan" },
			{
				type: "custom",
				customType: "pi-basics-plan-mode",
				data: {
					version: 1,
					phase: "none",
					planEntryId: "p1",
					planUrl: "file:///tmp/s#p1",
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
				initialAskPending: false,
			},
			plan: "# Plan",
		});
	});

	test("rejects malformed durable none boundaries", () => {
		expect(decodePlanBoundary({ version: 1, phase: "none", planEntryId: "" })).toBeUndefined();
		expect(
			decodePlanBoundary({ version: 1, phase: "none", planUrl: "file:///tmp/s#p1" }),
		).toBeUndefined();
		expect(
			decodePlanBoundary({
				version: 1,
				phase: "none",
				planEntryId: "p1",
				planUrl: "https://example.com/plan#p1",
			}),
		).toBeUndefined();
		expect(
			decodePlanBoundary({ version: 1, phase: "none", initialAskPending: "false" }),
		).toBeUndefined();
	});

	test("rejects a durable none boundary whose URL targets another artifact", () => {
		const entries = [
			{ id: "p1", type: "custom_message", customType: "pi-basics-plan", content: "# Plan" },
			{
				type: "custom",
				customType: "pi-basics-plan-mode",
				data: {
					version: 1,
					phase: "none",
					planEntryId: "p1",
					planUrl: "file:///tmp/s#p2",
				},
			},
		];
		expect(restorePlan(entries)).toEqual({
			boundary: { version: 1, phase: "none" },
			warning: "plan URL does not match artifact",
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
