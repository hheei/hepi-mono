import { expect, test } from "bun:test";
import type { MctxVisibleToolTag } from "../src/history-tags.js";
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

function candidate(
	tag: MctxHistoryTag,
	toolName = "bash",
	input: unknown = {},
): MctxVisibleToolTag {
	return { tag, toolName, input };
}

test("smart drops select oldest visible unprotected tool results until the target is met", (): void => {
	const first = tool(1, "a".repeat(40));
	const second = tool(2, "b".repeat(80));
	const third = tool(3, "c".repeat(80));
	const protectedTool = tool(5, "protected");
	const plan = planMctxSmartDrops({
		tags: [
			first,
			second,
			third,
			{
				kind: "message",
				entryId: "user",
				source: "never automatic",
				tagNumber: 4,
				status: "active",
			},
			protectedTool,
		],
		candidates: [candidate(first), candidate(second), candidate(third), candidate(protectedTool)],
		protectedTags: 2,
		usageTokens: 100,
		targetUsageTokens: 75,
	});
	expect(plan).toEqual({ kind: "drop", tagNumbers: [1, 2], estimatedReclaimTokens: 30 });
});

test("smart drops exclude hidden, pending, and protected tag identities", (): void => {
	const pending = tool(2, "pending", "pending");
	const newest = tool(3, "new");
	const plan = planMctxSmartDrops({
		tags: [tool(1, "old"), pending, newest],
		candidates: [candidate(pending), candidate(newest)],
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
			candidates: [],
			protectedTags: 0,
			usageTokens: 100,
			targetUsageTokens: 80,
		}),
	).toThrow("protectedTags");
});

test("smart drops reclaim safe superseded tool results before pressure ordering", (): void => {
	const oldStatus = tool(1, "old status");
	const newStatus = tool(2, "new status");
	const newest = tool(3, "payload");
	const plan = planMctxSmartDrops({
		tags: [oldStatus, newStatus, newest],
		candidates: [
			candidate(oldStatus, "bash_status"),
			candidate(newStatus, "bash_status"),
			candidate(newest),
		],
		protectedTags: 1,
		usageTokens: 100,
		targetUsageTokens: 95,
	});
	expect(plan).toEqual({ kind: "drop", tagNumbers: [1, 2], estimatedReclaimTokens: 6 });
});
