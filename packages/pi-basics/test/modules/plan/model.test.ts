import { describe, expect, test } from "bun:test";
import { extractProposedPlan, planStatus } from "../../../src/modules/plan/model.js";

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

	test("exposes revised phase statuses", () => {
		expect(planStatus("plan")).toBe("plan");
		expect(planStatus("plan-refine")).toBe("plan-refine");
		expect(planStatus("none")).toBeUndefined();
	});
});
