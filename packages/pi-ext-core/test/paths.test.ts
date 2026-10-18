import { describe, expect, test } from "vitest";
import { expandHome } from "../src/paths.js";

describe("expandHome", () => {
	const home = "/home/tester";

	test.each([
		{ input: "~", expected: "/home/tester", label: "expands a bare ~" },
		{ input: "~/", expected: "/home/tester", label: "expands a ~/ prefix with nothing after it" },
		{ input: "~/projects", expected: "/home/tester/projects", label: "expands a ~/ prefix" },
		{ input: "~/a/../b", expected: "/home/tester/b", label: "normalizes the expanded prefix" },
		{ input: "/var/log", expected: "/var/log", label: "leaves an absolute path" },
		{ input: "relative/path", expected: "relative/path", label: "leaves a relative path" },
		{
			input: "~user/path",
			expected: "~user/path",
			label: "leaves a ~ that is not the home prefix",
		},
		{ input: "", expected: "", label: "leaves an empty path" },
	])("$label", ({ input, expected }) => {
		expect(expandHome(input, home)).toBe(expected);
	});
});
