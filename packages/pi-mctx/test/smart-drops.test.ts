import { expect, test } from "bun:test";
import { planMctxSmartDrops } from "../src/smart-drops.js";
import type { MctxHistoryTag } from "../src/store.js";

function tool(
	tagNumber: number,
	source: string,
	status: MctxHistoryTag["status"] = "active",
): MctxHistoryTag {
	return {
		kind: "tool",
		entryId: `assistant-${tagNumber}`,
		toolCallId: `call-${tagNumber}`,
		source,
		tagNumber,
		status,
	};
}

test("smart drops select oldest visible unprotected tool results until the target is met", (): void => {
	const plan = planMctxSmartDrops({
		tags: [
			tool(1, "a".repeat(40)),
			tool(2, "b".repeat(80)),
			tool(3, "c".repeat(80)),
			{
				kind: "message",
				entryId: "user",
				source: "never automatic",
				tagNumber: 4,
				status: "active",
			},
			tool(5, "protected"),
		],
		visibleTagNumbers: new Set([1, 2, 3, 5]),
		protectedTags: 2,
		usageTokens: 100,
		targetUsageTokens: 75,
	});
	expect(plan).toEqual({ kind: "drop", tagNumbers: [1, 2], estimatedReclaimTokens: 30 });
});

test("smart drops exclude hidden, pending, and protected tag identities", (): void => {
	const plan = planMctxSmartDrops({
		tags: [tool(1, "old"), tool(2, "pending", "pending"), tool(3, "new")],
		visibleTagNumbers: new Set([2, 3]),
		protectedTags: 1,
		usageTokens: 100,
		targetUsageTokens: 50,
	});
	expect(plan).toEqual({ kind: "noop", reason: "no eligible tool results" });
});

test("smart drops reject malformed budgets", (): void => {
	expect(() =>
		planMctxSmartDrops({
			tags: [],
			visibleTagNumbers: new Set(),
			protectedTags: 0,
			usageTokens: 100,
			targetUsageTokens: 80,
		}),
	).toThrow("protectedTags");
});
