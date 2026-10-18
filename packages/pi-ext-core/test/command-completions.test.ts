import { describe, expect, test } from "vitest";
import { splitSubcommand, subcommandCompletions } from "../src/index.js";

const VERBS = ["on", "off", "status", "view", "view full", "consolidate", "compact"];
const NAMES = VERBS.filter((name) => !name.includes(" "));

describe("subcommandCompletions", () => {
	const completions = subcommandCompletions(VERBS);
	const verbs = NAMES.map((verb) => ({ value: verb, label: verb }));

	test.each([
		{ prefix: "", expected: verbs, label: "lists every verb for an empty prefix" },
		{ prefix: "   ", expected: verbs, label: "lists every verb for a blank prefix" },
		{
			prefix: "co",
			expected: [
				{ value: "consolidate", label: "consolidate" },
				{ value: "compact", label: "compact" },
			],
			label: "filters verbs by the typed prefix",
		},
		{
			prefix: "  ST",
			expected: [{ value: "status", label: "status" }],
			label: "matches the verb without regard to case",
		},
		{ prefix: "nope", expected: null, label: "returns null when nothing matches" },
		{
			prefix: "status ",
			expected: null,
			label: "returns null once a verb with no argument is complete",
		},
		{
			prefix: "view ",
			expected: [{ value: "view full", label: "full" }],
			label: "offers an argument only after its verb is typed",
		},
		{
			prefix: "view f",
			expected: [{ value: "view full", label: "full" }],
			label: "filters the argument and keeps the whole text as the value",
		},
		{ prefix: "view x", expected: null, label: "returns null when the argument does not match" },
		{
			prefix: "vi",
			expected: [{ value: "view", label: "view" }],
			label: "keeps a partial verb unambiguous against its argument",
		},
		{
			prefix: "consolidate ",
			expected: null,
			label: "does not invent an argument for a verb that has none",
		},
	])("$label", ({ prefix, expected }) => {
		expect(completions(prefix)).toEqual(expected);
	});
});

describe("splitSubcommand", () => {
	test.each([
		["  VIEW  full  ", { verb: "view", rest: "full" }],
		["reindex", { verb: "reindex", rest: "" }],
		["   ", { verb: "", rest: "" }],
		["cancel #1 #2", { verb: "cancel", rest: "#1 #2" }],
	] as const)("splits %j", (input, expected) => {
		expect(splitSubcommand(input)).toEqual(expected);
	});
});
