import { describe, expect, it } from "vitest";
import { transformSubagentsMarkdown } from "../src/markdown.js";

describe("transformSubagentsMarkdown", () => {
	it.each([
		{
			label: "wraps unquoted agent-hex and bash-N identifiers",
			input: "Task agent-3f9a1c completed successfully, while bash-2 is still running.",
			expected: "Task `agent-3f9a1c` completed successfully, while `bash-2` is still running.",
		},
		{
			label: "does not double-wrap identifiers that are already quoted",
			input: "Check `agent-3f9a1c` and `bash-3` logs.",
			expected: "Check `agent-3f9a1c` and `bash-3` logs.",
		},
		{
			label: "leaves identifiers inside fenced code untouched",
			input: [
				"Task agent-0beef1 finished.",
				"```sh",
				"echo agent-0beef1",
				"cat /tmp/bash-1.log",
				"```",
				"Also bash-9 finished.",
			].join("\n"),
			expected: [
				"Task `agent-0beef1` finished.",
				"```sh",
				"echo agent-0beef1",
				"cat /tmp/bash-1.log",
				"```",
				"Also `bash-9` finished.",
			].join("\n"),
		},
		{
			label: "does not wrap identifiers inside URLs or compound words",
			input: "See https://example.com/tasks/agent-3f9a1c or my_agent-3f9a1c_var.",
			expected: "See https://example.com/tasks/agent-3f9a1c or my_agent-3f9a1c_var.",
		},
	])("$label", ({ input, expected }) => {
		expect(transformSubagentsMarkdown(input)).toBe(expected);
	});
});
