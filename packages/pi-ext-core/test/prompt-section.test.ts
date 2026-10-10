import { describe, expect, test } from "vitest";
import { setPromptSection, setSectionBullet } from "../src/index.js";

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
		// Removing a section that was never there stays a no-op.
		setPromptSection(sections, "missing", undefined);
		expect(sections).toEqual({ keep: "kept" });
	});
});

describe("setSectionBullet", () => {
	test("adds bullets to a new or existing section", () => {
		const sections: Record<string, string> = {};
		setSectionBullet(sections, "deferred_tools", "subagents", "Subagent tools");
		expect(sections).toEqual({
			deferred_tools: "- subagents: Subagent tools",
		});

		setSectionBullet(sections, "deferred_tools", "background bash", "Shell tasks");
		expect(sections).toEqual({
			deferred_tools: "- subagents: Subagent tools\n- background bash: Shell tasks",
		});
	});

	test("replaces an existing bullet with the same key in-place preserving contributor order", () => {
		const sections: Record<string, string> = {
			deferred_tools: "- subagents: Old description\n- background bash: Shell tasks",
		};
		setSectionBullet(sections, "deferred_tools", "subagents", "New description");
		expect(sections).toEqual({
			deferred_tools: "- subagents: New description\n- background bash: Shell tasks",
		});
	});

	test("preserves non-bullet preamble lines and matches exact keys without false prefix matches", () => {
		const sections: Record<string, string> = {
			deferred_tools: "Header instructions:\n- subagents-extra: Extra tool\n- subagents: Base tool",
		};
		setSectionBullet(sections, "deferred_tools", "subagents", "Updated base tool");
		expect(sections).toEqual({
			deferred_tools:
				"Header instructions:\n- subagents-extra: Extra tool\n- subagents: Updated base tool",
		});
	});

	test("removes a bullet when text is undefined or empty", () => {
		const sections: Record<string, string> = {
			deferred_tools: "- subagents: Subagent tools\n- background bash: Shell tasks",
		};
		setSectionBullet(sections, "deferred_tools", "subagents", undefined);
		expect(sections).toEqual({
			deferred_tools: "- background bash: Shell tasks",
		});

		// Removing the last bullet deletes the entire section
		setSectionBullet(sections, "deferred_tools", "background bash", "");
		expect(sections).toEqual({});
	});
});
