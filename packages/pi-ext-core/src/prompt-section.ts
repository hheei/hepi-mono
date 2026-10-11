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
 * Sets or removes a keyed bullet point in a named prompt section (e.g. `deferred_tools`).
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
		`^[-*]\\s+(?:\\*{1,2}|\\x60)?${escapedKey}(?:\\*{1,2}|\\x60)?(?:\\s*:|\\s*—|\\s*-\\s|\\s*$)`,
		"i",
	);

	let formattedLine: string | undefined;
	if (text !== undefined && text.trim() !== "") {
		const trimmed = text.trim();
		formattedLine = trimmed.startsWith("- ")
			? trimmed
			: trimmed.toLowerCase().startsWith(`${key.toLowerCase()}:`)
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
				// if formattedLine is undefined, we omit the line (delete)
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

export interface DeferredToolPromptSpec {
	readonly key: string;
	readonly active: boolean;
	readonly guidanceSection: string;
	readonly guidanceContent?: string | undefined;
	readonly toolSearchBullet: string;
	readonly codemodeBullet: string;
}

/**
 * Synchronizes a deferred tool's discovery bullets and activation guidance.
 *
 * When `spec.active` is true:
 * - Clears the discovery bullet from `deferred_tools`.
 * - Sets the guidance section with `spec.guidanceContent`.
 *
 * When `spec.active` is false:
 * - Clears the guidance section.
 * - If `tool_search` is active, sets the bullet to `spec.toolSearchBullet`.
 * - Else if `codemode` is active, sets the bullet to `spec.codemodeBullet`.
 * - Otherwise, removes the bullet.
 */
export function syncDeferredToolPrompt(
	sections: Record<string, string>,
	activeTools: ReadonlySet<string>,
	spec: DeferredToolPromptSpec,
): void {
	if (spec.active) {
		setSectionBullet(sections, "deferred_tools", spec.key, undefined);
		setPromptSection(sections, spec.guidanceSection, spec.guidanceContent);
	} else {
		setPromptSection(sections, spec.guidanceSection, undefined);
		if (activeTools.has("tool_search")) {
			setSectionBullet(sections, "deferred_tools", spec.key, spec.toolSearchBullet);
		} else if (activeTools.has("codemode")) {
			setSectionBullet(sections, "deferred_tools", spec.key, spec.codemodeBullet);
		} else {
			setSectionBullet(sections, "deferred_tools", spec.key, undefined);
		}
	}
}
