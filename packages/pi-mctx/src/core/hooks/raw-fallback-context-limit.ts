import {
	EmergencyFailClosedError,
	ENGINE_RECONNECTING_USER_MESSAGE,
} from "./emergency-fail-closed";

export class RawFallbackContextLimitError extends Error {
	readonly code = "RAW_FALLBACK_CONTEXT_LIMIT";
	readonly recoverable = true;

	constructor(
		readonly estimatedTokens: number,
		readonly contextLimitTokens: number,
		options?: { cause?: unknown },
	) {
		super(ENGINE_RECONNECTING_USER_MESSAGE, options);
		this.name = "RawFallbackContextLimitError";
	}
}

export function isLoudTransformAbort(error: unknown, compactionOff: boolean): boolean {
	if (error instanceof RawFallbackContextLimitError) return true;
	if (compactionOff) return false;
	return error instanceof EmergencyFailClosedError;
}
