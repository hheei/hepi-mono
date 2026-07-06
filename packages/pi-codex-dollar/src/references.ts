import { highlightAccent } from "./text.js";
import type { DollarTheme, SkillCommand } from "./types.js";
import { getSkillPathMap } from "./skills.js";

const DOLLAR_REFERENCE_PATTERN = /(^|[\s([{])\$([A-Za-z0-9-]+)(?![A-Za-z0-9-:])/g;

export function expandDollarSkillReferences(
	text: string,
	commands: readonly SkillCommand[],
): string | null {
	let skills: Map<string, string> | undefined;
	let changed = false;

	const transformed = text.replace(DOLLAR_REFERENCE_PATTERN, (match, delimiter, rawName) => {
		skills ??= getSkillPathMap(commands);
		const skillPath = skills.get(rawName);
		if (!skillPath) return match;

		changed = true;
		return `${delimiter}${skillPath}`;
	});

	return changed ? transformed : null;
}

export function highlightDollarSkillReferences(
	text: string,
	commands: readonly SkillCommand[],
	theme?: DollarTheme,
): string {
	let skills: Map<string, string> | undefined;

	return text.replace(DOLLAR_REFERENCE_PATTERN, (match, delimiter, rawName) => {
		skills ??= getSkillPathMap(commands);
		if (!skills.has(rawName)) return match;

		return `${delimiter}${highlightAccent(`$${rawName}`, theme)}`;
	});
}
