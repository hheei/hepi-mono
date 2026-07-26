import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { type LoadoutKey, loadoutKey } from "./model.js";

type PromptSkill = NonNullable<BuildSystemPromptOptions["skills"]>[number];

export interface FilteredSkillPrompt {
	readonly systemPrompt: string;
	readonly skills: PromptSkill[];
}

const SKILLS_SECTION_START =
	"\n\nThe following skills provide specialized instructions for specific tasks.";
const SKILLS_SECTION_END = "</available_skills>";

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function formatSkillsForPrompt(skills: readonly PromptSkill[]): string {
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
	if (visibleSkills.length === 0) return "";
	const lines = [
		SKILLS_SECTION_START,
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push(SKILLS_SECTION_END);
	return lines.join("\n");
}

function replaceSkillsSection(
	systemPrompt: string,
	originalSection: string,
	filteredSection: string,
): string {
	if (originalSection !== "" && systemPrompt.includes(originalSection)) {
		return systemPrompt.replace(originalSection, filteredSection);
	}
	const start = systemPrompt.indexOf(SKILLS_SECTION_START);
	if (start === -1) return systemPrompt;
	const closing = systemPrompt.indexOf(SKILLS_SECTION_END, start);
	if (closing === -1) return systemPrompt;
	const end = closing + SKILLS_SECTION_END.length;
	return `${systemPrompt.slice(0, start)}${filteredSection}${systemPrompt.slice(end)}`;
}

function promptSkillKey(skill: PromptSkill): LoadoutKey {
	return loadoutKey("skill", skill.name);
}

export function filterLoadoutDisabledSkillsFromPrompt(
	systemPrompt: string,
	options: BuildSystemPromptOptions,
	disabledSkillKeys: ReadonlySet<string>,
): FilteredSkillPrompt | undefined {
	const skills = options.skills ?? [];
	const filteredSkills = skills.filter((skill) => !disabledSkillKeys.has(promptSkillKey(skill)));
	if (filteredSkills.length === skills.length) return undefined;
	return {
		systemPrompt: replaceSkillsSection(
			systemPrompt,
			formatSkillsForPrompt(skills),
			formatSkillsForPrompt(filteredSkills),
		),
		skills: filteredSkills,
	};
}
