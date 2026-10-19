/**
 * Escapes text that is embedded into generated markup.
 *
 * Task reminders embed user text in markup. Quotes are escaped too, so the result
 * is also safe inside an attribute value.
 */
export function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
