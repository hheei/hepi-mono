import { describe, expect, it } from "vitest";
import { transformHindsightMarkdown } from "../../src/hindsight/markdown.js";

describe("transformHindsightMarkdown", () => {
	it.each([
		{
			label: "transforms a plain page link",
			input: "Read [[page:kp-f67e8e4e9c8946ea9a6ed487989d4f70]] for details.",
			expected:
				"Read [📖 kp-f67e8e4e9c8946ea9a6ed487989d4f70](page:kp-f67e8e4e9c8946ea9a6ed487989d4f70) for details.",
		},
		{
			label: "transforms a page link that carries a title",
			input: "Consult [[page:kp-1234|Conventions and Patterns]] first.",
			expected: "Consult [📖 Conventions and Patterns](page:kp-1234) first.",
		},
		{
			label: "leaves fenced and inline code untouched",
			input: [
				"Outside: [[page:kp-1]]",
				"`[[page:kp-2]]`",
				"```markdown",
				"[[page:kp-3|Do Not Touch]]",
				"```",
				"And another [[page:kp-4|Final Page]].",
			].join("\n"),
			expected: [
				"Outside: [📖 kp-1](page:kp-1)",
				"`[[page:kp-2]]`",
				"```markdown",
				"[[page:kp-3|Do Not Touch]]",
				"```",
				"And another [📖 Final Page](page:kp-4).",
			].join("\n"),
		},
		{
			label: "returns text unchanged when it has no page links",
			input: "Normal markdown text without any page links.",
			expected: "Normal markdown text without any page links.",
		},
	])("$label", ({ input, expected }) => {
		expect(transformHindsightMarkdown(input)).toBe(expected);
	});
});
