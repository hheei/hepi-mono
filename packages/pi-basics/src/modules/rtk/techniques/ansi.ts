const ANSI_CSI_PATTERN = new RegExp("\\x1b\\[[0-9;]*[a-zA-Z]", "g");
const ANSI_OSC_TERMINATED_PATTERN = new RegExp("\\x1b\\][0-9;]*(?:\\x07|\\x1b\\\\)", "g");
const ANSI_OSC_PATTERN = new RegExp("\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", "g");

export function stripAnsi(text: string): string {
	return text
		.replace(ANSI_CSI_PATTERN, "")
		.replace(ANSI_OSC_TERMINATED_PATTERN, "")
		.replace(ANSI_OSC_PATTERN, "");
}

export function stripAnsiFast(text: string): string {
	if (!text.includes("\x1b")) {
		return text;
	}
	return stripAnsi(text);
}
