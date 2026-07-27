import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type { FffRuntime } from "./fff.js";

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
const MAX_RESULTS = 20;

function findLastDelimiter(text: string): number {
	for (let index = text.length - 1; index >= 0; index -= 1) {
		if (PATH_DELIMITERS.has(text[index] ?? "")) return index;
	}
	return -1;
}

function isTokenStart(text: string, index: number): boolean {
	return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function findUnclosedQuoteStart(text: string): number | undefined {
	let inQuotes = false;
	let quoteStart: number | undefined;
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== '"') continue;
		inQuotes = !inQuotes;
		if (inQuotes) quoteStart = index;
	}
	return inQuotes ? quoteStart : undefined;
}

function extractAtPrefix(text: string): string | undefined {
	const quoteStart = findUnclosedQuoteStart(text);
	if (
		quoteStart !== undefined &&
		quoteStart > 0 &&
		text[quoteStart - 1] === "@" &&
		isTokenStart(text, quoteStart - 1)
	)
		return text.slice(quoteStart - 1);
	const delimiter = findLastDelimiter(text);
	const tokenStart = delimiter === -1 ? 0 : delimiter + 1;
	return text[tokenStart] === "@" ? text.slice(tokenStart) : undefined;
}

function parseAtPrefix(prefix: string): {
	readonly rawQuery: string;
	readonly isQuotedPrefix: boolean;
} {
	return prefix.startsWith('@"')
		? { rawQuery: prefix.slice(2), isQuotedPrefix: true }
		: { rawQuery: prefix.slice(1), isQuotedPrefix: false };
}

function normalizeInsertedPath(value: string): string {
	let normalized = value.trim();
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized.startsWith('"') && normalized.endsWith('"') && normalized.length >= 2)
		normalized = normalized.slice(1, -1);
	return normalized;
}

function toSuggestion(
	relativePath: string,
	label: string,
	description: string,
	isQuotedPrefix: boolean,
): AutocompleteItem {
	const path = relativePath.replace(/\\/g, "/");
	const needsQuotes = isQuotedPrefix || path.includes(" ");
	return {
		value: needsQuotes ? `@"${path}"` : `@${path}`,
		label,
		description,
	};
}

class FffAutocompleteProvider implements AutocompleteProvider {
	constructor(
		private readonly baseProvider: AutocompleteProvider,
		private readonly getRuntime: () => FffRuntime | undefined,
		private readonly isEnabled: () => boolean,
	) {}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const runtime = this.getRuntime();
		if (!this.isEnabled() || runtime === undefined)
			return this.baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);
		const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const atPrefix = extractAtPrefix(textBeforeCursor);
		if (atPrefix === undefined)
			return this.baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);
		if (options.signal.aborted) return null;

		const { rawQuery, isQuotedPrefix } = parseAtPrefix(atPrefix);
		const candidates = await runtime.searchFileCandidates(rawQuery, MAX_RESULTS);
		if (options.signal.aborted || candidates.isErr() || candidates.value.length === 0)
			return this.baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);

		return {
			prefix: atPrefix,
			items: candidates.value.map((candidate) => {
				const matchType = candidate.score?.matchType ? ` · ${candidate.score.matchType}` : "";
				return toSuggestion(
					candidate.item.relativePath,
					candidate.item.fileName || candidate.item.relativePath,
					`${candidate.item.relativePath}${matchType}`,
					isQuotedPrefix,
				);
			}),
		};
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const runtime = this.getRuntime();
		if (runtime !== undefined && this.isEnabled())
			void runtime.trackQuery(prefix, normalizeInsertedPath(item.value));
		return this.baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean {
		return this.baseProvider.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
	}
}

export function createFffAutocompleteProvider(
	baseProvider: AutocompleteProvider,
	getRuntime: () => FffRuntime | undefined,
	isEnabled: () => boolean,
): AutocompleteProvider {
	return new FffAutocompleteProvider(baseProvider, getRuntime, isEnabled);
}
