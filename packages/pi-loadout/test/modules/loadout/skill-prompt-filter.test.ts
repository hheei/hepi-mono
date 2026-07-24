import { describe, expect, test } from "bun:test";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { filterLoadoutDisabledSkillsFromPrompt } from "../../../src/skill-prompt-filter.js";

function skill(name: string, source: string) {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: {
			path: `/skills/${name}/SKILL.md`,
			source,
			scope: "user" as const,
			origin: "top-level" as const,
		},
		disableModelInvocation: false,
	};
}

function systemPrompt(skills: readonly ReturnType<typeof skill>[]): string {
	const lines = [
		"base prompt",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const item of skills) {
		lines.push("  <skill>");
		lines.push(`    <name>${item.name}</name>`);
		lines.push(`    <description>${item.description}</description>`);
		lines.push(`    <location>${item.filePath}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>", "", "Current working directory: /tmp");
	return lines.join("\n");
}

describe("loadout skill prompt filtering", () => {
	test("removes a canonically disabled skill regardless of runtime source", () => {
		const enabled = skill("enabled", "local");
		const disabled = skill("disabled", "local");
		const options: BuildSystemPromptOptions = {
			cwd: "/tmp",
			skills: [enabled, disabled],
		};
		const prompt = systemPrompt([enabled, disabled]);

		const filtered = filterLoadoutDisabledSkillsFromPrompt(
			prompt,
			options,
			new Set(["skill:disabled"]),
		);

		expect(filtered?.skills).toEqual([enabled]);
		expect(filtered?.systemPrompt).toContain("enabled description");
		expect(filtered?.systemPrompt).not.toContain("disabled");
		expect(filtered?.systemPrompt).toContain("<available_skills>");
	});

	test("removes the whole empty skills section when every visible skill is disabled", () => {
		const disabled = skill("disabled", "local");
		const options: BuildSystemPromptOptions = { cwd: "/tmp", skills: [disabled] };
		const filtered = filterLoadoutDisabledSkillsFromPrompt(
			systemPrompt([disabled]),
			options,
			new Set(["skill:disabled"]),
		);

		expect(filtered?.skills).toEqual([]);
		expect(filtered?.systemPrompt).not.toContain("available_skills");
		expect(filtered?.systemPrompt).toContain("Current working directory");
	});
});
