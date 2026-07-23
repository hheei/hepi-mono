import { pathToFileURL } from "node:url";
import {
	PLAN_MESSAGE_TYPE,
	PLAN_MODE_CUSTOM_TYPE,
	type PlanPhase,
	type RequestedPlanAction,
} from "./model.js";

export { PLAN_MESSAGE_TYPE, PLAN_MODE_CUSTOM_TYPE };

export type PlanBoundary =
	| { readonly version: 1; readonly phase: "none" }
	| {
			readonly version: 1;
			readonly phase: "plan" | "plan-refine";
			readonly planEntryId?: string;
			readonly planUrl?: string;
			readonly requestedAction?: RequestedPlanAction;
			readonly initialAskPending: boolean;
	  };

export interface SessionEntry {
	readonly id?: unknown;
	readonly type?: unknown;
	readonly customType?: unknown;
	readonly data?: unknown;
	readonly content?: unknown;
}

export interface PlanEntryAppender {
	appendEntry<T>(customType: string, data: T): void;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}
function id(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 512;
}
function url(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("file://") && value.length <= 4096;
}

export function encodePlanBoundary(boundary: PlanBoundary): PlanBoundary | undefined {
	return decodePlanBoundary(boundary);
}

export function decodePlanBoundary(value: unknown): PlanBoundary | undefined {
	if (!record(value) || value.version !== 1 || typeof value.phase !== "string") return undefined;
	if (value.phase === "none")
		return keys(value, ["version", "phase"]) ? { version: 1, phase: "none" } : undefined;
	if (value.phase !== "plan" && value.phase !== "plan-refine") return undefined;
	if (
		!keys(value, [
			"version",
			"phase",
			"planEntryId",
			"planUrl",
			"requestedAction",
			"initialAskPending",
		])
	)
		return undefined;
	if (typeof value.initialAskPending !== "boolean") return undefined;
	if (value.planEntryId !== undefined && !id(value.planEntryId)) return undefined;
	if (value.planUrl !== undefined && !url(value.planUrl)) return undefined;
	if (
		value.requestedAction !== undefined &&
		value.requestedAction !== "new" &&
		value.requestedAction !== "compact" &&
		value.requestedAction !== "continue"
	)
		return undefined;
	if (value.planUrl !== undefined && value.planEntryId === undefined) return undefined;
	return {
		version: 1,
		phase: value.phase as Exclude<PlanPhase, "none">,
		...(value.planEntryId === undefined ? {} : { planEntryId: value.planEntryId }),
		...(value.planUrl === undefined ? {} : { planUrl: value.planUrl }),
		...(value.requestedAction === undefined ? {} : { requestedAction: value.requestedAction }),
		initialAskPending: value.initialAskPending,
	};
}

export function appendPlanBoundary(appender: PlanEntryAppender, boundary: PlanBoundary): void {
	const encoded = encodePlanBoundary(boundary);
	if (!encoded) throw new Error("invalid plan boundary");
	appender.appendEntry(PLAN_MODE_CUSTOM_TYPE, encoded);
}

export function planUrl(source: unknown, entryId: unknown): string | undefined {
	const sessionFile =
		typeof source === "string"
			? source
			: record(source) &&
					record(source.sessionManager) &&
					typeof source.sessionManager.getSessionFile === "function"
				? source.sessionManager.getSessionFile()
				: undefined;
	if (typeof sessionFile !== "string" || !sessionFile || !id(entryId)) return undefined;
	try {
		return `${pathToFileURL(sessionFile).href}#${encodeURIComponent(entryId)}`;
	} catch {
		return undefined;
	}
}

export function findPlanArtifact(
	entries: readonly SessionEntry[],
	entryId: string,
): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			!record(entry) ||
			entry.id !== entryId ||
			entry.type !== "custom_message" ||
			entry.customType !== PLAN_MESSAGE_TYPE
		)
			continue;
		const content = entry.content;
		if (typeof content === "string" && content.trim()) return content;
	}
	return undefined;
}

export interface RestoredPlan {
	readonly boundary: PlanBoundary;
	readonly plan?: string;
	readonly warning?: string;
}

export function restorePlan(
	entries: readonly SessionEntry[],
	onWarning?: (message: string) => void,
): RestoredPlan {
	let latest: PlanBoundary | undefined;
	let latestMalformed = false;
	for (const entry of entries) {
		if (!record(entry) || entry.type !== "custom" || entry.customType !== PLAN_MODE_CUSTOM_TYPE)
			continue;
		const decoded = decodePlanBoundary(entry.data);
		if (!decoded) latestMalformed = true;
		else {
			latestMalformed = false;
			latest = decoded;
		}
	}
	if (latestMalformed) {
		const warning = "malformed latest plan boundary";
		onWarning?.(warning);
		return { boundary: { version: 1, phase: "none" }, warning };
	}
	if (!latest || latest.phase === "none")
		return { boundary: latest ?? { version: 1, phase: "none" } };
	if (!latest.planEntryId)
		return {
			boundary: { version: 1, phase: "plan", initialAskPending: latest.initialAskPending },
			warning: "plan artifact missing",
		};
	const plan = findPlanArtifact(entries, latest.planEntryId);
	if (!plan) {
		const warning = "plan artifact missing";
		onWarning?.(warning);
		return {
			boundary: { version: 1, phase: "plan", initialAskPending: latest.initialAskPending },
			warning,
		};
	}
	if (latest.planUrl && !latest.planUrl.endsWith(`#${encodeURIComponent(latest.planEntryId)}`)) {
		const warning = "plan URL does not match artifact";
		onWarning?.(warning);
		return {
			boundary: { version: 1, phase: "plan", initialAskPending: latest.initialAskPending },
			warning,
		};
	}
	return { boundary: latest, plan };
}

export const replayPlan = restorePlan;
