import { describe, expect, it } from "vitest";
import { transformHindsightMarkdown } from "../../src/hindsight/markdown.js";

describe("transformHindsightMarkdown", () => {
	it("transforms plain page links", () => {
		const input = "Read [[page:kp-f67e8e4e9c8946ea9a6ed487989d4f70]] for details.";
		const output = transformHindsightMarkdown(input);
		expect(output).toBe(
			"Read [📖 kp-f67e8e4e9c8946ea9a6ed487989d4f70](page:kp-f67e8e4e9c8946ea9a6ed487989d4f70) for details.",
		);
	});

	it("transforms page links with titles", () => {
		const input = "Consult [[page:kp-1234|Conventions and Patterns]] first.";
		const output = transformHindsightMarkdown(input);
		expect(output).toBe("Consult [📖 Conventions and Patterns](page:kp-1234) first.");
	});

	it("preserves links inside code blocks and inline code", () => {
		const input = [
			"Outside: [[page:kp-1]]",
			"`[[page:kp-2]]`",
			"```markdown",
			"[[page:kp-3|Do Not Touch]]",
			"```",
			"And another [[page:kp-4|Final Page]].",
		].join("\n");

		const output = transformHindsightMarkdown(input);
		expect(output).toBe(
			[
				"Outside: [📖 kp-1](page:kp-1)",
				"`[[page:kp-2]]`",
				"```markdown",
				"[[page:kp-3|Do Not Touch]]",
				"```",
				"And another [📖 Final Page](page:kp-4).",
			].join("\n"),
		);
	});

	it("returns unchanged text when no links are present", () => {
		const input = "Normal markdown text without any page links.";
		expect(transformHindsightMarkdown(input)).toBe(input);
	});
});
