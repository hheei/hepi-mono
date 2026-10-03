/**
 * Transforms plain agent and background task identifiers (e.g. `agent-1`, `bash-1`)
 * in Markdown prose by wrapping them in inline code backticks, making them visually
 * distinct in terminal TUI rendering.
 *
 * Preserves text inside code blocks, inline code, and URLs intact.
 */
export function transformSubagentsMarkdown(markdown: string): string {
	if (!/(?:agent|bash)-\d+/.test(markdown)) return markdown;

	// Split by code blocks (```...```) and inline code (`...`) to only transform prose
	const parts = markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
	for (let i = 0; i < parts.length; i += 2) {
		const part = parts[i];
		if (part !== undefined && /(?:agent|bash)-\d+/.test(part)) {
			// Match word boundary: agent-N or bash-N not inside markdown link URLs like (http.../agent-1)
			parts[i] = part.replace(/(?<![`/\w])((?:agent|bash)-\d+)(?![`\w])/g, "`$1`");
		}
	}
	return parts.join("");
}
