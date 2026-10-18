import { describe, expect, it } from "vitest";
import { transformSubagentsMarkdown } from "../src/markdown.js";

describe("transformSubagentsMarkdown", () => {
	it.each([
		{
			label: "wraps unquoted agent-N and bash-N identifiers",
			input: "Task agent-1 completed successfully, while bash-2 is still running.",
			expected: "Task `agent-1` completed successfully, while `bash-2` is still running.",
		},
		{
			label: "does not double-wrap identifiers that are already quoted",
			input: "Check `agent-1` and `bash-3` logs.",
			expected: "Check `agent-1` and `bash-3` logs.",
		},
		{
			label: "leaves identifiers inside fenced code untouched",
			input: [
				"Task agent-5 finished.",
				"```sh",
				"echo agent-5",
				"cat /tmp/bash-1.log",
				"```",
				"Also bash-9 finished.",
			].join("\n"),
			expected: [
				"Task `agent-5` finished.",
				"```sh",
				"echo agent-5",
				"cat /tmp/bash-1.log",
				"```",
				"Also `bash-9` finished.",
			].join("\n"),
		},
		{
			label: "does not wrap identifiers inside URLs or compound words",
			input: "See https://example.com/tasks/agent-1 or my_agent-1_var.",
			expected: "See https://example.com/tasks/agent-1 or my_agent-1_var.",
		},
	])("$label", ({ input, expected }) => {
		expect(transformSubagentsMarkdown(input)).toBe(expected);
	});
});
