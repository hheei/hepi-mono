/**
 * Owns one named section of Pi's structured system prompt.
 *
 * Every turn must supply the complete desired sections, including unchanged text. Pi diffs
 * that state against the transcript and records only changed or removed sections. Omitting a
 * section removes it. Providers that support mid-conversation system messages keep updates
 * in place; other providers fold them into the leading prompt, which can invalidate its cache.
 * Returning a forced `systemPrompt` projects the whole prompt onto the request instead.
 *
 * Pass `undefined` (or empty text) to remove the section. `name` must match Pi's section-name
 * rule — a lower-case identifier that may contain digits, `-` and `_` — because Pi rejects an
 * invalid name when it renders the prompt.
 */
export function setPromptSection(
	sections: Record<string, string>,
	name: string,
	content: string | undefined,
): void {
	if (content === undefined || content.trim() === "") {
		delete sections[name];
		return;
	}
	sections[name] = content;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sets or removes a keyed bullet point in a named prompt section.
 *
 * Each item in the section is represented as `- ${key}: ${text}` (or `- ${text}` if text already begins with key).
 * If `text` is undefined or blank, the item for `key` is removed.
 * If the section has no items left, the entire section is deleted from `sections`.
 */
export function setSectionBullet(
	sections: Record<string, string>,
	sectionName: string,
	key: string,
	text: string | undefined,
): void {
	const current = sections[sectionName];
	if (current === undefined && (text === undefined || text.trim() === "")) {
		return;
	}

	const rawLines = current ? current.split("\n") : [];
	const escapedKey = escapeRegex(key);
	const keyRegex = new RegExp(
		`^[-*]\\s+(?:\\*{1,2}|\\x60)?${escapedKey}(?:\\*{1,2}|\\x60)?(?:\\s*:|\\s*—|\\s*-\\s|\\s*\\(|\\s*$)`,
		"i",
	);

	let formattedLine: string | undefined;
	if (text !== undefined && text.trim() !== "") {
		const trimmed = text.trim();
		formattedLine = trimmed.startsWith("- ")
			? trimmed
			: trimmed.toLowerCase().startsWith(`${key.toLowerCase()}:`) ||
					trimmed.toLowerCase().startsWith(`${key.toLowerCase()} (`)
				? `- ${trimmed}`
				: `- ${key}: ${trimmed}`;
	}

	let replaced = false;
	const nextLines: string[] = [];

	for (const line of rawLines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
			if (keyRegex.test(trimmed)) {
				if (formattedLine !== undefined) {
					nextLines.push(formattedLine);
					replaced = true;
				}
				continue;
			}
		}
		nextLines.push(line);
	}

	if (!replaced && formattedLine !== undefined) {
		nextLines.push(formattedLine);
	}

	const hasContent = nextLines.some((l) => l.trim() !== "");
	const hasBullets = nextLines.some((l) => l.trim().startsWith("- ") || l.trim().startsWith("* "));

	if (!hasContent || !hasBullets) {
		delete sections[sectionName];
	} else {
		sections[sectionName] = nextLines.join("\n");
	}
}

export const OPTIONAL_TOOLS_SECTION = "optional_tools";
export const OPTIONAL_TOOLS_PREAMBLE =
	'If not loaded, use tool_search ({ query: "<query>" }) or call via codemode.';

/**
 * Sets or removes a stable item in the `optional_tools` prompt section.
 * The section maintains a fixed instruction preamble at top followed by non-duplicative bullets.
 */
export function setOptionalToolBullet(
	sections: Record<string, string>,
	key: string,
	bullet: string | undefined,
): void {
	const current = sections[OPTIONAL_TOOLS_SECTION];
	if (bullet === undefined || bullet.trim() === "") {
		if (current !== undefined) {
			setSectionBullet(sections, OPTIONAL_TOOLS_SECTION, key, undefined);
			const updated = sections[OPTIONAL_TOOLS_SECTION];
			if (updated !== undefined && updated.trim() === OPTIONAL_TOOLS_PREAMBLE) {
				delete sections[OPTIONAL_TOOLS_SECTION];
			}
		}
		return;
	}

	if (current === undefined || current.trim() === "") {
		const trimmed = bullet.trim();
		const formatted = trimmed.startsWith("- ") ? trimmed : `- ${trimmed}`;
		sections[OPTIONAL_TOOLS_SECTION] = `${OPTIONAL_TOOLS_PREAMBLE}\n${formatted}`;
		return;
	}

	if (!current.startsWith(OPTIONAL_TOOLS_PREAMBLE)) {
		sections[OPTIONAL_TOOLS_SECTION] = `${OPTIONAL_TOOLS_PREAMBLE}\n${current}`;
	}

	setSectionBullet(sections, OPTIONAL_TOOLS_SECTION, key, bullet);
}
