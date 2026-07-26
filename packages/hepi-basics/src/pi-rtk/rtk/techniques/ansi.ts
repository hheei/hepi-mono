const ESCAPE_PATTERN = "\\x1b";
const BELL_PATTERN = "\\x07";
const ANSI_CSI_PATTERN = new RegExp(`${ESCAPE_PATTERN}\\[[0-9;]*[a-zA-Z]`, "g");
const ANSI_OSC_TERMINATED_PATTERN = new RegExp(
	`${ESCAPE_PATTERN}\\][0-9;]*(?:${BELL_PATTERN}|${ESCAPE_PATTERN}\\\\)`,
	"g",
);
const ANSI_OSC_PATTERN = new RegExp(
	`${ESCAPE_PATTERN}\\][^${BELL_PATTERN}${ESCAPE_PATTERN}]*(?:${BELL_PATTERN}|${ESCAPE_PATTERN}\\\\)`,
	"g",
);

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
