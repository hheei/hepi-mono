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
