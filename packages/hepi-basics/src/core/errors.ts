export type UiErrorKind = "parse" | "storage" | "unknown";

export class HepiUiError extends Error {
	readonly kind: UiErrorKind;
	readonly cause?: unknown;
	constructor(kind: UiErrorKind, message: string, cause?: unknown) {
		super(message);
		this.name = "HePiUiError";
		this.kind = kind;
		this.cause = cause;
	}
}

export class HepiParseError extends HepiUiError {
	constructor(message: string, cause?: unknown) {
		super("parse", message, cause);
		this.name = "HePiParseError";
	}
}

export class HepiStorageError extends HepiUiError {
	constructor(message: string, cause?: unknown) {
		super("storage", message, cause);
		this.name = "HePiStorageError";
	}
}

function messageOf(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error) || String(error);
	} catch {
		return String(error);
	}
}

/** Convert failures to stable UI messages; original failure remains available as cause. */
export function toUiError(error: unknown, kind: UiErrorKind = "unknown"): HepiUiError {
	if (error instanceof HepiUiError) return error;
	const message = messageOf(error);
	if (kind === "parse") return new HepiParseError(`Invalid setting value: ${message}`, error);
	if (kind === "storage") return new HepiStorageError(`Unable to save settings: ${message}`, error);
	return new HepiUiError("unknown", message, error);
}

export function formatUiError(error: unknown, kind?: UiErrorKind): string {
	return toUiError(error, kind).message;
}

export const readableError = formatUiError;
