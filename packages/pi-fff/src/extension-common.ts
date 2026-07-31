import { TaggedError } from "better-result";
import { formatGrepError, formatPathResolutionError } from "./error-format.js";
import { type GrepSearchError, type PathResolutionError } from "./errors.js";
import type {
	FindFilesResponse,
	GrepSearchResponse,
	HealthCheck,
	ResolvedPath,
	RuntimeMetadata,
} from "./fff.js";

export const FFF_RUNTIME_NOT_READY_TEXT = "FFF runtime is not ready.";


export function buildReadFailureMessage(
	action: string,
	query: string,
	error: PathResolutionError,
): string {
	return formatPathResolutionError(action, query, error);
}

export function buildGrepFailureMessage(error: GrepSearchError, pathQuery?: string): string {
	return formatGrepError(error, pathQuery);
}

export function locationToReadParams(
	resolution: ResolvedPath,
	offset: number | undefined,
	limit: number | undefined,
) {
	if (offset !== undefined || !resolution.location) return { offset, limit };
	if (resolution.location.type === "line") {
		return { offset: resolution.location.line, limit: limit ?? 80 };
	}
	if (resolution.location.type === "position") {
		return { offset: resolution.location.line, limit: limit ?? 80 };
	}
	const rangeSize = Math.max(1, resolution.location.end.line - resolution.location.start.line + 1);
	return { offset: resolution.location.start.line, limit: limit ?? Math.max(rangeSize, 20) };
}

export function grepNeedsBuiltinFallback(params: {
	pattern: string;
	ignoreCase?: boolean;
	literal?: boolean;
}): boolean {
	if (params.ignoreCase === false && params.pattern.toLowerCase() === params.pattern) return true;
	if (params.ignoreCase === true && !params.literal) return true;
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

export function inferFffGrepMode(literal?: boolean): "plain" | "regex" {
	return literal === false ? "regex" : "plain";
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

export function buildGrepDetails(
	result?: GrepSearchResponse,
	error?: { message: string } | null,
) {
	return {
		truncation: result?.truncation,
		matchLimitReached: result?.matchLimitReached,
		linesTruncated: result?.linesTruncated ?? false,
		regexFallbackError: result?.regexFallbackError,
		resolvedScope: result?.scope?.relativePath,
		nextCursor: result?.nextCursor ?? null,
		constraints: result?.constraintQuery ?? null,
		suggestedReadPath: result?.suggestedReadPath ?? null,
		...buildErrorDetails(error),
	};
}

export function buildFindFilesDetails(
	result?: FindFilesResponse,
	error?: { message: string } | null,
) {
	return {
		nextCursor: result?.nextCursor ?? null,
		totalMatched: result?.totalMatched ?? null,
		totalFiles: result?.totalFiles ?? null,
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
