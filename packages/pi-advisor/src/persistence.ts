import { ADVISOR_MODE_CUSTOM_TYPE, type AdvisorBoundary } from "./model.js";
export interface AdvisorEntry {
	readonly type?: unknown;
	readonly customType?: unknown;
	readonly data?: unknown;
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function decodeAdvisorBoundary(value: unknown): AdvisorBoundary | undefined {
	if (!record(value) || value.version !== 1 || typeof value.enabled !== "boolean") return undefined;
	if (Object.keys(value).some((key) => key !== "version" && key !== "enabled")) return undefined;
	return { version: 1, enabled: value.enabled };
}
export function encodeAdvisorBoundary(value: AdvisorBoundary): AdvisorBoundary {
	const decoded = decodeAdvisorBoundary(value);
	if (!decoded) throw new Error("invalid advisor boundary");
	return decoded;
}
export interface AdvisorAppender {
	appendEntry<T>(customType: string, data: T): void;
}
export function appendAdvisorBoundary(appender: AdvisorAppender, value: AdvisorBoundary): void {
	appender.appendEntry(ADVISOR_MODE_CUSTOM_TYPE, encodeAdvisorBoundary(value));
}
export function restoreAdvisor(
	entries: readonly AdvisorEntry[],
	onWarning?: (message: string) => void,
): AdvisorBoundary {
	let latest: AdvisorBoundary | undefined;
	let malformed = false;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ADVISOR_MODE_CUSTOM_TYPE) continue;
		const decoded = decodeAdvisorBoundary(entry.data);
		malformed = decoded === undefined;
		if (decoded) latest = decoded;
	}
	if (malformed) {
		onWarning?.("malformed latest advisor boundary");
		return { version: 1, enabled: false };
	}
	return latest ?? { version: 1, enabled: false };
}
