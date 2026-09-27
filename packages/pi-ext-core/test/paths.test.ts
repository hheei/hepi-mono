import { describe, expect, test } from "vitest";
import { expandHome } from "../src/paths.js";

describe("expandHome", () => {
	test("expands a bare ~ and a ~/ prefix against the home directory", () => {
		expect(expandHome("~", "/home/tester")).toBe("/home/tester");
		expect(expandHome("~/projects", "/home/tester")).toBe("/home/tester/projects");
		expect(expandHome("~/", "/home/tester")).toBe("/home/tester");
	});

	test("leaves other paths untouched, including a ~ that is not a prefix", () => {
		expect(expandHome("/var/log", "/home/tester")).toBe("/var/log");
		expect(expandHome("relative/path", "/home/tester")).toBe("relative/path");
		expect(expandHome("~user/path", "/home/tester")).toBe("~user/path");
		expect(expandHome("", "/home/tester")).toBe("");
	});

	test("resolves the rest of the path so callers get a normalized prefix", () => {
		expect(expandHome("~/a/../b", "/home/tester")).toBe("/home/tester/b");
	});
});
