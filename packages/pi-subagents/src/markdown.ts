/**
 * Transforms plain agent and background task identifiers (e.g. `agent-3f9a1c`, `bash-1`)
 * in Markdown prose by wrapping them in inline code backticks, making them visually
 * distinct in terminal TUI rendering.
 *
 * Preserves text inside code blocks, inline code, and URLs intact.
 */
const IDENTIFIER = /(?:agent-[0-9a-f]{6}|bash-\d+)/;

export function transformSubagentsMarkdown(markdown: string): string {
	if (!IDENTIFIER.test(markdown)) return markdown;

	// Split by code blocks (```...```) and inline code (`...`) to only transform prose
	const parts = markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
	for (let i = 0; i < parts.length; i += 2) {
		const part = parts[i];
		if (part !== undefined && IDENTIFIER.test(part)) {
			// Word boundary: the id is not part of a longer word or a markdown link URL
			parts[i] = part.replace(/(?<![`/\w])((?:agent-[0-9a-f]{6}|bash-\d+))(?![`\w])/gu, "`$1`");
		}
	}
	return parts.join("");
}
