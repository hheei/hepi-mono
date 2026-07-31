import { describe, expect, test } from "bun:test";
import {
	buildReviewContext,
	buildSessionContext,
	buildTurnDelta,
	estimateTokens,
} from "../../../src/pi-advisor/context.js";
import {
	collectFeedback,
	emptyFeedback,
	markFeedbackDelivered,
	reconfirmFeedback,
} from "../../../src/pi-advisor/feedback.js";
import { decodeAdvisorBoundary, restoreAdvisor } from "../../../src/pi-advisor/persistence.js";
import { ADVISOR_SYSTEM_PROMPT } from "../../../src/pi-advisor/prompt.js";

describe("advisor contracts", () => {
	test("uses deterministic terse reviewer instructions", () => {
		expect(ADVISOR_SYSTEM_PROMPT).toContain("Output terse");
		expect(ADVISOR_SYSTEM_PROMPT).toContain("advise({severity,note})");
		expect(ADVISOR_SYSTEM_PROMPT).not.toMatch(/timestamp|current date/i);
	});
	test("strictly decodes and fails closed on malformed latest boundary", () => {
		expect(decodeAdvisorBoundary({ version: 1, enabled: true })).toEqual({
			version: 1,
			enabled: true,
		});
		expect(decodeAdvisorBoundary({ version: 1, enabled: true, extra: 1 })).toBeUndefined();
		expect(
			restoreAdvisor([
				{
					type: "custom",
					customType: "pi-basics-advisor-mode",
					data: { version: 1, enabled: true },
				},
				{ type: "custom", customType: "pi-basics-advisor-mode", data: { enabled: false } },
			]),
		).toEqual({ version: 1, enabled: false });
	});
	test("deduplicates and escalates advice, then reconfirms high severity", () => {
		const state = collectFeedback(emptyFeedback(), [
			{ severity: "concern", note: " Check auth " },
			{ severity: "blocker", note: "check   auth" },
			{ severity: "nit", note: "style" },
		]);
		expect(state.held).toEqual([{ severity: "blocker", note: "check   auth" }]);
		expect(
			reconfirmFeedback(state, [{ severity: "blocker", note: "check auth" }]).deliverable,
		).toHaveLength(2);
	});
	test("reconfirmation preserves severity escalation", () => {
		const state = collectFeedback(emptyFeedback(), [{ severity: "concern", note: "same note" }]);
		const reconfirmed = reconfirmFeedback(state, [{ severity: "blocker", note: " Same   Note " }]);
		expect(reconfirmed.held).toEqual([{ severity: "blocker", note: "same note" }]);
		expect(reconfirmed.deliverable).toEqual([{ severity: "blocker", note: "same note" }]);
	});
	test("remembers delivered severity and permits only escalation", () => {
		const delivered = markFeedbackDelivered(
			collectFeedback(emptyFeedback(), [{ severity: "nit", note: "same note" }]),
			[{ severity: "nit", note: "same note" }],
		);
		expect(
			collectFeedback(delivered, [{ severity: "nit", note: " Same   Note " }]).deliverable,
		).toHaveLength(0);
		expect(collectFeedback(delivered, [{ severity: "concern", note: "same note" }]).held).toEqual([
			{ severity: "concern", note: "same note" },
		]);
	});
	test("keeps a bounded review history while retaining the latest turn", () => {
		const history = Array.from({ length: 12 }, (_, index) =>
			buildTurnDelta(`turn-${index}`, undefined),
		);
		const current = buildTurnDelta("latest", undefined);
		const context = buildReviewContext(history, current, 4);
		expect(context).toContain("turn-11");
		expect(context).toContain("latest");
		expect(context).not.toContain("turn-0");
	});
	test("fits turn context and includes truncation marker", () => {
		const delta = buildTurnDelta("u".repeat(20000), "a".repeat(20000), ["tool".repeat(1000)], {
			contextWindow: 1024,
			responseReserve: 256,
		});
		expect(buildSessionContext(delta)).toContain("truncated");
		expect(estimateTokens(buildSessionContext(delta))).toBeGreaterThan(0);
	});
});
