import type { GrepSearchError, PathResolutionError } from "./errors.js";
import { AmbiguousPathError, EmptyPathQueryError, MissingPathError } from "./errors.js";
import { formatCandidateLines } from "./fff-format.js";

export function formatPathResolutionError(
	action: string,
	query: string,
	error: PathResolutionError,
): string {
	if (!(error instanceof AmbiguousPathError)) return error.message;
	return [
		`Could not resolve "${query}" uniquely for ${action}.`,
		"Top matches:",
		...formatCandidateLines(error.candidates),
	].join("\n");
}

export function formatGrepError(error: GrepSearchError, pathQuery?: string): string {
	const pathScoped =
		error instanceof AmbiguousPathError ||
		error instanceof EmptyPathQueryError ||
		error instanceof MissingPathError;
	return pathScoped
		? formatPathResolutionError("grep scope", pathQuery ?? "", error)
		: error.message;
}
