import { describe, expect, test } from "bun:test";
import { type DialogUI, runAskFallback } from "../src/fallback.js";
import { formatAskResult, normalizeAskParams } from "../src/model.js";

function questionnaire(multi = false) {
	return normalizeAskParams({
		questions: [
			{
				id: "q",
				question: "Choose",
				options: [{ label: "One", description: "first" }, { label: "Two" }],
				multi,
			},
		],
	});
}
function scripted(selects: (string | undefined)[], inputs: (string | undefined)[] = []): DialogUI {
	return {
		select: async (_title, _options) => selects.shift(),
		input: async () => inputs.shift(),
	};
}

describe("ask fallback", () => {
	test("matches exact wire values and submits", async () => {
		const result = await runAskFallback(
			questionnaire(),
			scripted(["1. One — first", "Submit answers"]),
		);
		expect(result.status).toBe("submitted");
		if (result.status === "submitted")
			expect(result.details.answers[0]!.selected).toEqual([{ index: 0, label: "One" }]);
	});
	test("rejects unknown host values", async () => {
		await expect(runAskFallback(questionnaire(), scripted(["1. One"]))).rejects.toThrow(
			"unsupported",
		);
	});
	test("supports explicit empty multi and cancellation", async () => {
		const submitted = await runAskFallback(
			questionnaire(true),
			scripted(["Finish selection", "Submit answers"]),
		);
		expect(submitted.status).toBe("submitted");
		if (submitted.status === "submitted")
			expect(submitted.details.answers[0]!.selected).toEqual([]);
		const cancelled = await runAskFallback(questionnaire(), scripted([undefined]));
		expect(cancelled).toMatchObject({
			status: "cancelled",
			details: { answers: [], cancelled: true },
		});
	});
	test("shares bounded custom validator", async () => {
		await expect(
			runAskFallback(questionnaire(), scripted(["3. Other (type your own)"], ["unsafe\tvalue"])),
		).rejects.toThrow("invalid custom");
	});
	test("abort is distinct from dismiss", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runAskFallback(questionnaire(), scripted([]), controller.signal);
		expect(result.status).toBe("aborted");
		expect(formatAskResult(result.details)).toBe(
			"Ask questionnaire was aborted before submission.",
		);
	});
});
