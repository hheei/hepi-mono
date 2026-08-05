import type { AgentToolResult, GrepToolDetails } from "@earendil-works/pi-coding-agent";

type GrepContent = { readonly type: "text"; readonly text: string };
type NormalizedGrepDetails = GrepToolDetails & {
	readonly format?: "fff-grep";
	readonly totalMatched?: number;
	readonly totalFiles?: number;
};

export type GrepResultLike = {
	readonly content: GrepContent[];
	readonly details: NormalizedGrepDetails | undefined;
};

const NATIVE_MATCH_LINE = /^(.+?):(\d+): ?(.*)$/;
const NATIVE_CONTEXT_LINE = /^(.+?)-(\d+)- ?(.*)$/;

function resultText(result: GrepResultLike): string {
	return result.content.map((part) => part.text).join("\n");
}

function canonicalizeNativeText(text: string): {
	readonly text: string;
	readonly files: number;
	readonly matches: number;
} {
	const lines = text.split("\n");
	const output: string[] = [];
	const files = new Set<string>();
	let currentFile: string | undefined;
	let matches = 0;
	for (const line of lines) {
		const match = line.match(NATIVE_MATCH_LINE) ?? line.match(NATIVE_CONTEXT_LINE);
		if (!match) {
			output.push(line);
			continue;
		}
		const file = match[1] ?? "";
		const number = match[2] ?? "0";
		const separator = line.match(NATIVE_MATCH_LINE) ? ":" : "│";
		if (file !== currentFile) {
			if (output.length > 0 && output.at(-1) !== "") output.push("");
			output.push(file);
			currentFile = file;
			files.add(file);
		}
		if (separator === ":") matches += 1;
		output.push(`${number}${separator}${match[3] ?? ""}`);
	}
	return {
		text: output.join("\n").replace(/^No matches found\.?$/gm, "No match found"),
		files: files.size,
		matches,
	};
}

export function addGrepSummary(
	text: string,
	totals: { readonly matches: number; readonly files: number },
): string {
	return `Found ${totals.matches} matches in ${totals.files} files.\n\n${text}`;
}

export function normalizeNativeGrepResult(
	result: AgentToolResult<GrepToolDetails | undefined>,
): GrepResultLike {
	const textResult: GrepResultLike = {
		content: result.content.filter((part): part is GrepContent => part.type === "text"),
		details: result.details,
	};
	const canonical = canonicalizeNativeText(resultText(textResult));
	return {
		content: [{ type: "text", text: addGrepSummary(canonical.text, canonical) }],
		details: {
			format: "fff-grep",
			totalMatched: canonical.matches,
			totalFiles: canonical.files,
			...(typeof result.details === "object" && result.details !== null ? result.details : {}),
		},
	};
}
