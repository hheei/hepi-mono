/**
 * Owns one named section of Pi's structured system prompt.
 *
 * Pi records the prompt as independent sections and, on every provider request, sends only the
 * sections whose text changed, replacing the previous text of the section it names. An
 * extension that instead concatenates its text onto `event.systemPrompt` forces Pi to send the
 * whole prompt again every turn, and the injected text is no longer replaceable on its own.
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
