import { matchError } from "better-result";
import type { GrepSearchError, PathResolutionError } from "./errors.js";
import { formatCandidateLines } from "./fff-format.js";

export function formatPathResolutionError(
	action: string,
	query: string,
	error: PathResolutionError,
): string {
	return matchError(error, {
		AmbiguousPathError: (resolution) =>
			[
				`Could not resolve "${query}" uniquely for ${action}.`,
				"Top matches:",
				...formatCandidateLines(resolution.candidates),
			].join("\n"),
		EmptyPathQueryError: (resolution) => resolution.message,
		MissingPathError: (resolution) => resolution.reason,
		RuntimeInitializationError: (resolution) => resolution.message,
		FinderOperationError: (resolution) => resolution.message,
	});
}

export function formatGrepError(error: GrepSearchError, pathQuery?: string): string {
	return matchError(error, {
		AmbiguousPathError: (pathError) =>
			formatPathResolutionError("grep scope", pathQuery ?? "", pathError),
		EmptyPathQueryError: (pathError) =>
			formatPathResolutionError("grep scope", pathQuery ?? "", pathError),
		MissingPathError: (pathError) =>
			formatPathResolutionError("grep scope", pathQuery ?? "", pathError),
		RuntimeInitializationError: (runtimeError) => runtimeError.message,
		FinderOperationError: (finderError) => finderError.message,
		ExternalGrepScopeError: (scopeError) => scopeError.message,
		InvalidGrepCursorError: (cursorError) => cursorError.message,
		GrepCursorMismatchError: (cursorError) => cursorError.message,
	});
}
