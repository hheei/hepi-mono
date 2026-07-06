import { highlightAccent } from "./text.js";
import type { DollarTheme, SkillCommand } from "./types.js";
import { getSkillPathMap } from "./skills.js";

const DOLLAR_REFERENCE_PATTERN = /(^| )\$([A-Za-z0-9-]+)( |$)/g;

export function expandDollarSkillReferences(
	text: string,
	commands: readonly SkillCommand[],
): string | null {
	let skills: Map<string, string> | undefined;
	let changed = false;

	const transformed = text.replace(DOLLAR_REFERENCE_PATTERN, (match, leadingSpace, rawName, trailingSpace) => {
		skills ??= getSkillPathMap(commands);
		const skillPath = skills.get(rawName);
		if (!skillPath) return match;

		changed = true;
		return `${leadingSpace}${skillPath}${trailingSpace}`;
	});

	return changed ? transformed : null;
}

export function highlightDollarSkillReferences(
	text: string,
	commands: readonly SkillCommand[],
	theme?: DollarTheme,
): string {
	let skills: Map<string, string> | undefined;

	return text.replace(DOLLAR_REFERENCE_PATTERN, (match, leadingSpace, rawName, trailingSpace) => {
		skills ??= getSkillPathMap(commands);
		if (!skills.has(rawName)) return match;

		return `${leadingSpace}${highlightAccent(`$${rawName}`, theme)}${trailingSpace}`;
	});
}
