import { expect, test } from "bun:test";
import {
	buildMctxToolGuidance,
	buildMctxToolReminder,
	estimateMctxToolTokens,
} from "../src/tool-guidance.js";

test("builds stable system guidance for tool-only context reduction", (): void => {
	const prompt = buildMctxToolGuidance(20, false);
	expect(prompt).toContain("## Magic Context");
	expect(prompt).toContain('"3-5", "1,2,9", or "1-5,8,12-15"');
	expect(prompt).toContain("newest 20 tags are protected");
	expect(prompt).toContain("Do not drop user, assistant, or reference text");
	expect(prompt).toContain("Never narrate a drop");
	expect(prompt).toContain("Never simulate a dropped tool call");
});

test("warns against caveman-style imitation only when compression is enabled", (): void => {
	expect(buildMctxToolGuidance(20, false)).not.toContain("Do not imitate it");
	expect(buildMctxToolGuidance(20, true)).toContain("Do not imitate it");
});

test("builds bounded tool-only nudge reminders", (): void => {
	expect(buildMctxToolReminder([1, 2, 3], false)).toContain("1,2,3");
	expect(buildMctxToolReminder([1], true)).toContain("Reclaim now before continuing");
	expect(estimateMctxToolTokens("12345")).toBe(2);
});
