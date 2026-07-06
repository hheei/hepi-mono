import type { DollarTheme, SelectListTheme } from "./types.js";

export function normalize(value: unknown): string {
	return String(value ?? "").toLowerCase();
}

export function bareSkillName(commandName: unknown): string {
	const name = String(commandName ?? "");
	return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

export function padRight(text: string, width: number): string {
	if (text.length >= width) return text;
	return text + " ".repeat(width - text.length);
}

export function truncate(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	if (width <= 1) return text.slice(0, width);
	return `${text.slice(0, width - 1)}…`;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function styleSelectList(theme: DollarTheme | undefined): SelectListTheme | DollarTheme | undefined {
	return theme?.selectList ?? theme;
}

export function styleDescription(text: string | undefined, theme?: DollarTheme): string {
	if (!text) return text ?? "";
	const selectList = styleSelectList(theme);
	return typeof selectList?.description === "function" ? selectList.description(text) : text;
}

export function styleScrollInfo(text: string | undefined, theme?: DollarTheme): string {
	if (!text) return text ?? "";
	const selectList = styleSelectList(theme);
	return typeof selectList?.scrollInfo === "function" ? selectList.scrollInfo(text) : text;
}

export function styleSelectedRow(text: string, theme?: DollarTheme): string {
	if (!text) return text;
	const selectList = styleSelectList(theme);
	return typeof selectList?.selectedText === "function" ? selectList.selectedText(text) : text;
}

export function styleInactiveRow(text: string, theme?: DollarTheme): string {
	return styleDescription(text, theme);
}

function themeFgFirst(
	theme: DollarTheme | undefined,
	keys: string[],
	text: string,
): string | undefined {
	if (!theme?.fg || !text) return undefined;

	for (const key of keys) {
		try {
			const styled = theme.fg(key, text);
			if (styled && styled !== text) return styled;
		} catch {
			// Unknown theme keys are optional.
		}
	}

	return undefined;
}

export function highlightAccent(text: string, theme?: DollarTheme): string {
	if (!text) return text;
	return (
		themeFgFirst(
			theme,
			["codexDollarHighlight", "codexDollarSelected", "mdCode", "syntaxType", "toolTitle"],
			text,
		) ?? styleSelectedRow(text, theme)
	);
}

export function wrapText(text: unknown, width: number): string[] {
	if (width <= 0) return [""];
	const normalized = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) return [""];

	const lines = [];
	let current = "";

	for (const word of normalized.split(" ")) {
		if (word.length > width) {
			if (current) {
				lines.push(current);
				current = "";
			}
			for (let i = 0; i < word.length; i += width) {
				lines.push(word.slice(i, i + width));
			}
			continue;
		}

		const next = current ? `${current} ${word}` : word;
		if (next.length <= width) {
			current = next;
		} else {
			if (current) lines.push(current);
			current = word;
		}
	}

	if (current) lines.push(current);
	return lines.length > 0 ? lines : [""];
}
