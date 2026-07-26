export type StatusbarFormatVariable =
	| "prefix"
	| "thinking"
	| "model"
	| "context"
	| "statuses"
	| "fill"
	| "title";

export type StatusbarFormatToken =
	| { readonly type: "text"; readonly value: string }
	| { readonly type: "variable"; readonly name: StatusbarFormatVariable };

export type StatusbarFormatPart = {
	readonly type: "text" | "variable";
	readonly name?: Exclude<StatusbarFormatVariable, "fill">;
	readonly value: string;
};

export type StatusbarFormatValues = Readonly<
	Record<Exclude<StatusbarFormatVariable, "fill">, string>
>;

export type RenderedStatusbarFormat = Readonly<{
	beforeFill: readonly StatusbarFormatPart[];
	afterFill: readonly StatusbarFormatPart[];
}>;

export const DEFAULT_STATUSBAR_FORMAT = "$prefix$thinking $model$context$statuses$fill$title";

const FORMAT_VARIABLES = new Set<StatusbarFormatVariable>([
	"prefix",
	"thinking",
	"model",
	"context",
	"statuses",
	"fill",
	"title",
]);

export function parseStatusbarFormat(format: string): readonly StatusbarFormatToken[] {
	const tokens: StatusbarFormatToken[] = [];
	const variable = /\$([A-Za-z_][A-Za-z0-9_]*)/gu;
	let cursor = 0;
	for (const match of format.matchAll(variable)) {
		const index = match.index ?? 0;
		if (index > cursor) tokens.push({ type: "text", value: format.slice(cursor, index) });
		const name = match[1];
		if (!name || !FORMAT_VARIABLES.has(name as StatusbarFormatVariable))
			throw new Error(`Unknown statusbar format variable: ${name ?? ""}`);
		tokens.push({ type: "variable", name: name as StatusbarFormatVariable });
		cursor = index + match[0].length;
	}
	if (cursor < format.length) tokens.push({ type: "text", value: format.slice(cursor) });
	return tokens;
}

export const DEFAULT_STATUSBAR_FORMAT_TOKENS = parseStatusbarFormat(DEFAULT_STATUSBAR_FORMAT);

export function renderStatusbarFormat(
	tokens: readonly StatusbarFormatToken[],
	values: StatusbarFormatValues,
): RenderedStatusbarFormat {
	const beforeFill: StatusbarFormatPart[] = [];
	const afterFill: StatusbarFormatPart[] = [];
	let target = beforeFill;
	for (const token of tokens) {
		if (token.type === "text") {
			target.push({ type: "text", value: token.value });
			continue;
		}
		if (token.name === "fill") {
			target = afterFill;
			continue;
		}
		target.push({ type: "variable", name: token.name, value: values[token.name] });
	}
	return { beforeFill, afterFill };
}

export function joinStatusbarFormat(parts: readonly StatusbarFormatPart[]): string {
	return parts.map((part) => part.value).join("");
}
