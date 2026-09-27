import { describe, expect, test } from "vitest";
import { setPromptSection } from "../src/index.js";

describe("setPromptSection", () => {
	test("adds and replaces one section without touching the others", () => {
		const sections: Record<string, string> = { preamble: "base" };
		setPromptSection(sections, "pi-ext-memory-recall", "fact one");
		expect(sections).toEqual({ preamble: "base", "pi-ext-memory-recall": "fact one" });
		setPromptSection(sections, "pi-ext-memory-recall", "fact two");
		expect(sections).toEqual({ preamble: "base", "pi-ext-memory-recall": "fact two" });
	});

	test("removes a section for undefined and for blank content", () => {
		const sections: Record<string, string> = { keep: "kept", drop: "gone", blank: "gone" };
		setPromptSection(sections, "drop", undefined);
		setPromptSection(sections, "blank", "   \n ");
		expect(sections).toEqual({ keep: "kept" });
	});

	test("removing a section that is not there is a no-op", () => {
		const sections: Record<string, string> = { keep: "kept" };
		setPromptSection(sections, "missing", undefined);
		expect(sections).toEqual({ keep: "kept" });
	});
});
