import { describe, expect, test } from "bun:test";
import { extractProposedPlan, planStatus, stripProposedPlan } from "../../src/pi-plan/model.js";

describe("plan model", () => {
	test("extracts canonical blocks without a hard length limit", () => {
		const longPlan = "x".repeat(4_001);
		expect(
			extractProposedPlan("before\n<proposed_plan>\n# Ship\n\nsteps\n</proposed_plan>\nafter"),
		).toBe("# Ship\n\nsteps");
		expect(extractProposedPlan("<proposed_plan>bad</proposed_plan>")).toBeUndefined();
		expect(extractProposedPlan("<proposed_plan>\n\n</proposed_plan>")).toBeUndefined();
		expect(
			extractProposedPlan(
				"<proposed_plan>\na\n</proposed_plan>\n<proposed_plan>\nb\n</proposed_plan>",
			),
		).toBeUndefined();
		expect(extractProposedPlan(`<proposed_plan>\n${longPlan}\n</proposed_plan>`)).toBe(longPlan);
	});

	test("strips one canonical block from assistant display text", () => {
		expect(stripProposedPlan("before\n<proposed_plan>\n# Ship\n</proposed_plan>\nafter")).toBe(
			"before\n\nafter",
		);
		expect(stripProposedPlan("<proposed_plan>\n# Ship\n</proposed_plan>")).toBe("");
		expect(stripProposedPlan("ordinary response")).toBeUndefined();
	});

	test("exposes revised phase statuses", () => {
		expect(planStatus("plan")).toBe("plan");
		expect(planStatus("plan-refine")).toBe("plan-refine");
		expect(planStatus("none")).toBeUndefined();
	});
});
