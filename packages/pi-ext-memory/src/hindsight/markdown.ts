/**
 * Transforms Hindsight knowledge page wiki-links into styled Markdown links.
 *
 * Supported formats:
 * - `[[page:kp-xxxx|Custom Title]]` -> `[📖 Custom Title](page:kp-xxxx)`
 * - `[[page:kp-xxxx]]` -> `[📖 kp-xxxx](page:kp-xxxx)`
 */
export function transformHindsightMarkdown(markdown: string): string {
	if (!markdown.includes("[[page:")) return markdown;

	// Split by fenced code blocks and inline code so code blocks are preserved intact
	const parts = markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
	for (let i = 0; i < parts.length; i += 2) {
		const part = parts[i];
		if (part?.includes("[[page:")) {
			parts[i] = part.replace(
				/\[\[page:([a-zA-Z0-9_-]+)(?:\|([^\]]+))?\]\]/g,
				(_match, pageId, title) => {
					const label = title ? title.trim() : pageId;
					return `[📖 ${label}](page:${pageId})`;
				},
			);
		}
	}
	return parts.join("");
}
