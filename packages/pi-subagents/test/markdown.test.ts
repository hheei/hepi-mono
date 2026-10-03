import { describe, expect, it } from "vitest";
import { transformSubagentsMarkdown } from "../src/markdown.js";

describe("transformSubagentsMarkdown", () => {
	it("wraps unquoted agent-N and bash-N identifiers in code backticks", () => {
		const input = "Task agent-1 completed successfully, while bash-2 is still running.";
		const output = transformSubagentsMarkdown(input);
		expect(output).toBe("Task `agent-1` completed successfully, while `bash-2` is still running.");
	});

	it("preserves already quoted identifiers without double wrapping", () => {
		const input = "Check `agent-1` and `bash-3` logs.";
		const output = transformSubagentsMarkdown(input);
		expect(output).toBe("Check `agent-1` and `bash-3` logs.");
	});

	it("preserves code blocks without modifying contents", () => {
		const input = [
			"Task agent-5 finished.",
			"```sh",
			"echo agent-5",
			"cat /tmp/bash-1.log",
			"```",
			"Also bash-9 finished.",
		].join("\n");

		const output = transformSubagentsMarkdown(input);
		expect(output).toBe(
			[
				"Task `agent-5` finished.",
				"```sh",
				"echo agent-5",
				"cat /tmp/bash-1.log",
				"```",
				"Also `bash-9` finished.",
			].join("\n"),
		);
	});

	it("does not wrap parts of URLs or compound words", () => {
		const input = "See https://example.com/tasks/agent-1 or my_agent-1_var.";
		const output = transformSubagentsMarkdown(input);
		expect(output).toBe("See https://example.com/tasks/agent-1 or my_agent-1_var.");
	});
});
