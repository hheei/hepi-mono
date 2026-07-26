export type UiErrorKind = "parse" | "storage" | "unknown";

export class HePiUiError extends Error {
	readonly kind: UiErrorKind;
	readonly cause?: unknown;
	constructor(kind: UiErrorKind, message: string, cause?: unknown) {
		super(message);
		this.name = "HePiUiError";
		this.kind = kind;
		this.cause = cause;
	}
}

export class HePiParseError extends HePiUiError {
	constructor(message: string, cause?: unknown) {
		super("parse", message, cause);
		this.name = "HePiParseError";
	}
}

export class HePiStorageError extends HePiUiError {
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
export function toUiError(error: unknown, kind: UiErrorKind = "unknown"): HePiUiError {
	if (error instanceof HePiUiError) return error;
	const message = messageOf(error);
	if (kind === "parse") return new HePiParseError(`Invalid setting value: ${message}`, error);
	if (kind === "storage") return new HePiStorageError(`Unable to save settings: ${message}`, error);
	return new HePiUiError("unknown", message, error);
}

export function formatUiError(error: unknown, kind?: UiErrorKind): string {
	return toUiError(error, kind).message;
}

export const readableError = formatUiError;
