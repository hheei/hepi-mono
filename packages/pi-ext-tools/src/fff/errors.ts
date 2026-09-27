import type { FffFileCandidate } from "./fff-types.js";

function messageFromCause(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Tagged error values carried inside `AppResult`. They are never thrown, so each
 * class builds its message once and keeps the fields the formatters need.
 */
export class RuntimeInitializationError {
	readonly cwd: string;
	readonly step: string;
	readonly cause: unknown;
	readonly message: string;

	constructor(args: { cwd: string; step: string; cause: unknown }) {
		this.cwd = args.cwd;
		this.step = args.step;
		this.cause = args.cause;
		this.message = `Failed to initialize FFF runtime (${args.step}) for ${args.cwd}: ${messageFromCause(args.cause)}`;
	}
}

export class FinderOperationError {
	readonly operation: string;
	readonly reason: string;
	readonly cause: unknown;
	readonly message: string;

	constructor(args: { operation: string; reason: string; cause?: unknown }) {
		this.operation = args.operation;
		this.reason = args.reason;
		this.cause = args.cause;
		this.message = `FFF ${args.operation} failed: ${args.reason}`;
	}
}

export class EmptyPathQueryError {
	readonly query: string;
	readonly message = "Path query is empty.";

	constructor(args: { query: string }) {
		this.query = args.query;
	}
}

export class MissingPathError {
	readonly query: string;
	readonly reason: string;
	readonly message: string;

	constructor(args: { query: string; reason: string }) {
		this.query = args.query;
		this.reason = args.reason;
		this.message = args.reason;
	}
}

export class AmbiguousPathError {
	readonly query: string;
	readonly candidates: FffFileCandidate[];
	readonly message: string;

	constructor(args: { query: string; candidates: FffFileCandidate[] }) {
		this.query = args.query;
		this.candidates = args.candidates;
		this.message = `Ambiguous path query: ${args.query}`;
	}
}

export class InvalidGrepCursorError {
	readonly cursor: string;
	readonly message = "Invalid or expired grep cursor.";

	constructor(args: { cursor: string }) {
		this.cursor = args.cursor;
	}
}

export class GrepCursorMismatchError {
	readonly cursor: string;
	readonly message = "This grep cursor belongs to a different query. Re-run without cursor.";

	constructor(args: { cursor: string }) {
		this.cursor = args.cursor;
	}
}

export class ExternalGrepScopeError {
	readonly path: string;
	readonly projectRoot: string;
	readonly message: string;

	constructor(args: { path: string; projectRoot: string }) {
		this.path = args.path;
		this.projectRoot = args.projectRoot;
		this.message = `Path is outside the FFF project root: ${args.path}`;
	}
}

export type PathResolutionError =
	| EmptyPathQueryError
	| MissingPathError
	| AmbiguousPathError
	| RuntimeInitializationError
	| FinderOperationError;
export type RelatedFilesError = PathResolutionError | FinderOperationError;
export type GrepSearchError =
	| InvalidGrepCursorError
	| GrepCursorMismatchError
	| ExternalGrepScopeError
	| PathResolutionError
	| FinderOperationError;
