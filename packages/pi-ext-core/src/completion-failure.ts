import type { CompletionFailure } from "./subagents.js";

const TRANSIENT_HTTP_STATUS = new Set([408, 409, 425, 429]);
const TRANSIENT_TRANSPORT_CODES = new Set([
	"EAI_AGAIN",
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"ENETDOWN",
	"ENETUNREACH",
	"ENOTFOUND",
	"EPIPE",
	"ETIMEDOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_SOCKET",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}

function integerStatus(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599
		? value
		: undefined;
}

function errorEvidence(error: unknown): { readonly status?: number; readonly code?: string } {
	const seen = new Set<object>();
	let current: unknown = error;
	let unknownCode: string | undefined;
	for (let depth = 0; depth < 8 && isRecord(current); depth++) {
		if (seen.has(current)) break;
		seen.add(current);
		const status = integerStatus(current.status) ?? integerStatus(current.statusCode);
		const code = typeof current.code === "string" ? current.code : undefined;
		if (status !== undefined || (code !== undefined && TRANSIENT_TRANSPORT_CODES.has(code)))
			return {
				...(status === undefined ? {} : { status }),
				...(code === undefined ? {} : { code }),
			};
		if (unknownCode === undefined) unknownCode = code;
		current = current.cause;
	}
	return unknownCode === undefined ? {} : { code: unknownCode };
}

export function configurationFailure(message: string): CompletionFailure {
	return { kind: "configuration", message };
}

export function invalidResponseFailure(message: string): CompletionFailure {
	return { kind: "invalid-response", message };
}

/**
 * Classifies only transport evidence carried by the thrown error or a bounded
 * cause chain. Provider prose changes frequently, so message matching would
 * make a consumer's retry policy unsafe.
 */
export function classifyCompletionFailure(error: unknown, message: string): CompletionFailure {
	const evidence = errorEvidence(error);
	if (evidence.status === 401 || evidence.status === 403)
		return { kind: "authentication", message, ...evidence };
	if (
		evidence.status !== undefined &&
		evidence.status >= 400 &&
		evidence.status < 500 &&
		!TRANSIENT_HTTP_STATUS.has(evidence.status)
	)
		return { kind: "invalid-request", message, ...evidence };
	if (
		(evidence.status !== undefined &&
			(TRANSIENT_HTTP_STATUS.has(evidence.status) || evidence.status >= 500)) ||
		(evidence.code !== undefined && TRANSIENT_TRANSPORT_CODES.has(evidence.code))
	)
		return { kind: "transient", message, ...evidence };
	return { kind: "unknown", message, ...evidence };
}
