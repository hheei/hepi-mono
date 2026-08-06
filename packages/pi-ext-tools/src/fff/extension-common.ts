import { TaggedError } from "better-result";
import { formatGrepError } from "./error-format.js";
import type { GrepSearchError } from "./errors.js";
import type { GrepSearchResponse, HealthCheck, RuntimeMetadata } from "./fff.js";
import { isValidRegexPattern } from "./query.js";

export const FFF_RUNTIME_NOT_READY_TEXT = "FFF runtime is not ready.";

export function buildGrepFailureMessage(error: GrepSearchError, pathQuery?: string): string {
	return formatGrepError(error, pathQuery);
}

export function grepNeedsBuiltinFallback(params: {
	pattern: string;
	ignoreCase?: boolean;
}): boolean {
	// FFF supports case-sensitive matching, so an explicit false is compatible.
	if (params.ignoreCase === true) return true;
	return false;
}

export function normalizeMode(mode: string | undefined): "plain" | "regex" | "fuzzy" {
	if (mode === "regex" || mode === "fuzzy") return mode;
	return "plain";
}

export function normalizeOutputMode(
	mode: string | undefined,
): "content" | "files_with_matches" | "count" | "usage" | undefined {
	if (mode === "files_with_matches" || mode === "count" || mode === "usage" || mode === "content")
		return mode;
	return undefined;
}

export function inferFffGrepMode(literal?: boolean, pattern?: string): "plain" | "regex" {
	// Pi grep treats an omitted `literal` as false, so its default is regex.
	return literal === true || (pattern !== undefined && !isValidRegexPattern(pattern))
		? "plain"
		: "regex";
}

export function buildErrorDetails(error?: { message: string } | null) {
	if (!error) {
		return {
			error: null,
			errorTag: null,
			errorData: null,
		};
	}

	const errorData = Object.fromEntries(
		Object.entries(error).filter(([key]) => key !== "message" && key !== "name" && key !== "stack"),
	);
	return {
		error: error.message,
		errorTag: TaggedError.is(error) ? error._tag : null,
		errorData: Object.keys(errorData).length > 0 ? errorData : null,
	};
}

export function buildGrepDetails(result?: GrepSearchResponse, error?: { message: string } | null) {
	const files = new Set(result?.items.map((item) => item.relativePath));
	return {
		format: "fff-grep" as const,
		totalMatched: result?.items.length ?? 0,
		totalFiles: files.size,
		...(result?.truncation === undefined ? {} : { truncation: result.truncation }),
		...(result?.matchLimitReached === undefined
			? {}
			: { matchLimitReached: result.matchLimitReached }),
		linesTruncated: result?.linesTruncated ?? false,
		...(result?.regexFallbackError === undefined
			? {}
			: { regexFallbackError: result.regexFallbackError }),
		...(result?.scope?.relativePath === undefined
			? {}
			: { resolvedScope: result.scope.relativePath }),
		nextCursor: result?.nextCursor ?? null,
		constraints: result?.constraintQuery ?? null,
		suggestedReadPath: result?.suggestedReadPath ?? null,
		...buildErrorDetails(error),
	};
}

export function buildStatusReport(args: {
	status: { state: string; indexedFiles?: number; error?: string };
	health?: HealthCheck;
	metadata: RuntimeMetadata;
	healthError?: { message: string } | null;
}) {
	const lines = [
		`state: ${args.status.state}`,
		`indexed files: ${args.status.indexedFiles ?? "unknown"}`,
		`cwd: ${args.metadata.cwd}`,
		`project root: ${args.metadata.projectRoot}`,
		`index base path: ${args.health?.filePicker.basePath ?? args.metadata.projectRoot}`,
		`git repository: ${args.health?.git.repositoryFound ? "yes" : "no"}`,
		`frecency db: ${args.metadata.frecencyDbPath}`,
		`history db: ${args.metadata.historyDbPath}`,
		`frecency tracking: ${args.health?.frecency.initialized ? "on" : "off"}`,
		`query history: ${args.health?.queryTracker.initialized ? "on" : "off"}`,
		`definition classification: ${args.metadata.definitionClassification}`,
	];
	if (args.status.error) lines.push(`error: ${args.status.error}`);
	if (args.healthError) lines.push(`health: ${args.healthError.message}`);
	return lines.join("\n");
}
