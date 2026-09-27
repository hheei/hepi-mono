import { describe, expect, test } from "vitest";
import { subcommandCompletions } from "../src/index.js";

const VERBS = ["on", "off", "status", "view", "consolidate", "compact"];

describe("subcommandCompletions", () => {
	test("completes every subcommand for an empty prefix", () => {
		const completions = subcommandCompletions(VERBS);
		expect(completions("")).toEqual(VERBS.map((verb) => ({ value: verb, label: verb })));
		expect(completions("   ")).toEqual(VERBS.map((verb) => ({ value: verb, label: verb })));
	});

	test("filters the subcommand being typed and ignores case", () => {
		const completions = subcommandCompletions(VERBS);
		expect(completions("co")).toEqual([
			{ value: "consolidate", label: "consolidate" },
			{ value: "compact", label: "compact" },
		]);
		expect(completions("  ST")).toEqual([{ value: "status", label: "status" }]);
	});

	test("returns null when nothing matches", () => {
		const completions = subcommandCompletions(VERBS);
		expect(completions("nope")).toBeNull();
		expect(completions("status ")).toBeNull();
	});

	test("completes a fixed argument as the whole argument text", () => {
		const completions = subcommandCompletions(VERBS, { args: { view: ["full"] } });
		expect(completions("view ")).toEqual([{ value: "view full", label: "full" }]);
		expect(completions("view f")).toEqual([{ value: "view full", label: "full" }]);
		expect(completions("view x")).toBeNull();
	});

	test("does not leak argument completions to subcommands without arguments", () => {
		const completions = subcommandCompletions(VERBS, { args: { view: ["full"] } });
		expect(completions("status f")).toBeNull();
		expect(completions("consolidate ")).toBeNull();
	});

	test("resolves the argument table case-insensitively", () => {
		const completions = subcommandCompletions(VERBS, { args: { view: ["full"] } });
		expect(completions("VIEW f")).toEqual([{ value: "VIEW full", label: "full" }]);
	});
});
