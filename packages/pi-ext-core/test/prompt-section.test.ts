import { describe, expect, test } from "vitest";
import {
	OPTIONAL_TOOLS_PREAMBLE,
	OPTIONAL_TOOLS_SECTION,
	setOptionalToolBullet,
	setPromptSection,
	setSectionBullet,
} from "../src/index.js";

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
		setPromptSection(sections, "missing", undefined);
		expect(sections).toEqual({ keep: "kept" });
	});
});

describe("setSectionBullet", () => {
	test("adds bullets to a new or existing section", () => {
		const sections: Record<string, string> = {};
		setSectionBullet(sections, "tools", "subagents", "Subagent tools");
		expect(sections).toEqual({
			tools: "- subagents: Subagent tools",
		});

		setSectionBullet(sections, "tools", "background bash", "Shell tasks");
		expect(sections).toEqual({
			tools: "- subagents: Subagent tools\n- background bash: Shell tasks",
		});
	});

	test("replaces an existing bullet with the same key in-place preserving contributor order", () => {
		const sections: Record<string, string> = {
			tools: "- subagents: Old description\n- background bash: Shell tasks",
		};
		setSectionBullet(sections, "tools", "subagents", "New description");
		expect(sections).toEqual({
			tools: "- subagents: New description\n- background bash: Shell tasks",
		});
	});

	test("preserves non-bullet preamble lines and matches exact keys without false prefix matches", () => {
		const sections: Record<string, string> = {
			tools: "Header instructions:\n- subagents-extra: Extra tool\n- subagents: Base tool",
		};
		setSectionBullet(sections, "tools", "subagents", "Updated base tool");
		expect(sections).toEqual({
			tools: "Header instructions:\n- subagents-extra: Extra tool\n- subagents: Updated base tool",
		});
	});

	test("removes a bullet when text is undefined or empty", () => {
		const sections: Record<string, string> = {
			tools: "- subagents: Subagent tools\n- background bash: Shell tasks",
		};
		setSectionBullet(sections, "tools", "subagents", undefined);
		expect(sections).toEqual({
			tools: "- background bash: Shell tasks",
		});

		setSectionBullet(sections, "tools", "background bash", "");
		expect(sections).toEqual({});
	});
});

describe("setOptionalToolBullet", () => {
	test("initializes optional_tools with fixed preamble and clean non-duplicative bullet", () => {
		const sections: Record<string, string> = {};
		setOptionalToolBullet(
			sections,
			"background bash",
			'background bash (query: "bg_bash"): Run background tasks (bg_bash_spawn).',
		);
		expect(sections[OPTIONAL_TOOLS_SECTION]).toBe(
			`${OPTIONAL_TOOLS_PREAMBLE}\n- background bash (query: "bg_bash"): Run background tasks (bg_bash_spawn).`,
		);
	});

	test("appends additional optional tool bullets under the same shared preamble", () => {
		const sections: Record<string, string> = {};
		setOptionalToolBullet(
			sections,
			"background bash",
			'background bash (query: "bg_bash"): Run background tasks (bg_bash_spawn).',
		);
		setOptionalToolBullet(
			sections,
			"subagents",
			'subagents (query: "agent"): Multi-agent delegation (agent_spawn).',
		);
		expect(sections[OPTIONAL_TOOLS_SECTION]).toBe(
			`${OPTIONAL_TOOLS_PREAMBLE}\n- background bash (query: "bg_bash"): Run background tasks (bg_bash_spawn).\n- subagents (query: "agent"): Multi-agent delegation (agent_spawn).`,
		);
	});

	test("removes bullet and deletes section when all bullets are removed", () => {
		const sections: Record<string, string> = {};
		setOptionalToolBullet(
			sections,
			"background bash",
			'background bash (query: "bg_bash"): Run background tasks.',
		);
		setOptionalToolBullet(sections, "background bash", undefined);
		expect(sections[OPTIONAL_TOOLS_SECTION]).toBeUndefined();
	});
});
