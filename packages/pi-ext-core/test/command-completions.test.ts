import { describe, expect, test } from "vitest";
import { splitSubcommand, subcommandCompletions } from "../src/index.js";

const VERBS = ["on", "off", "status", "view", "view full", "consolidate", "compact"];
const NAMES = VERBS.filter((name) => !name.includes(" "));

describe("subcommandCompletions", () => {
	test("completes every verb for an empty prefix and filters by what is typed", () => {
		const completions = subcommandCompletions(VERBS);
		expect(completions("")).toEqual(NAMES.map((verb) => ({ value: verb, label: verb })));
		expect(completions("   ")).toEqual(NAMES.map((verb) => ({ value: verb, label: verb })));
		// Matching ignores case, mirroring handlers that lowercase the verb themselves.
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

	test("only offers a candidate with an argument once its verb is typed", () => {
		const completions = subcommandCompletions(VERBS);
		// The whole argument text is the value, because the host replaces all of it.
		expect(completions("view ")).toEqual([{ value: "view full", label: "full" }]);
		expect(completions("view f")).toEqual([{ value: "view full", label: "full" }]);
		expect(completions("view x")).toBeNull();
		// Verb-level completion stays unambiguous: `vi` offers the verb, not its argument.
		expect(completions("vi")).toEqual([{ value: "view", label: "view" }]);
		expect(completions("consolidate ")).toBeNull();
	});
});

describe("splitSubcommand", () => {
	test("lowercases the verb and keeps the remaining argument text", () => {
		expect(splitSubcommand("  VIEW  full  ")).toEqual({ verb: "view", rest: "full" });
		expect(splitSubcommand("reindex")).toEqual({ verb: "reindex", rest: "" });
		expect(splitSubcommand("   ")).toEqual({ verb: "", rest: "" });
		expect(splitSubcommand("cancel #1 #2")).toEqual({ verb: "cancel", rest: "#1 #2" });
	});
});
