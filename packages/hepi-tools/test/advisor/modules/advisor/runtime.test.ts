import { describe, expect, test } from "bun:test";
import { parseAdvisorReview } from "../../../../src/pi-advisor/model.js";
import { ADVISOR_SYSTEM_PROMPT } from "../../../../src/pi-advisor/prompt.js";

const validReview = JSON.stringify({
	advice: [{ severity: "blocker", note: "Validate the persisted model before use." }],
});

describe("Advisor JSON review output", () => {
	test("accepts a complete JSON fixture", () => {
		expect(parseAdvisorReview(validReview)).toEqual([
			{ severity: "blocker", note: "Validate the persisted model before use." },
		]);
	});

	test("rejects non-JSON and schema drift", () => {
		for (const output of [
			'```json\n{"advice":[]}\n```',
			'{"advice":[],"extra":true}',
			'{"advice":[{"severity":"blocker","note":"x","extra":true}]}',
			'{"advice":[{"severity":"unknown","note":"x"}]}',
		])
			expect(() => parseAdvisorReview(output)).toThrow();
	});

	test("requires JSON-only output in the model policy", () => {
		expect(ADVISOR_SYSTEM_PROMPT).toContain("Output exactly one JSON object and nothing else");
	});
});
