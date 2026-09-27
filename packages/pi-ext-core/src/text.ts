/**
 * Escapes text that is embedded into generated markup.
 *
 * Two consumers generate markup from session data — `pi-debug` renders an SVG of a
 * replay frame and `pi-ext-tools` wraps a task subject into a reminder block — and both
 * need the same five replacements. Quotes are escaped too, so the result is also safe
 * inside an attribute value.
 */
export function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
