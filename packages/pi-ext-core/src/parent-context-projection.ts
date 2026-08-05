import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { createServiceKey } from "./service.js";

export type ParentContextProjectionPurpose = "handoff" | "inheritance";
export interface ParentContextProjectionUnavailable {
	readonly kind: "unavailable";
}
export interface ParentContextProjectionStale {
	readonly kind: "stale";
}
export interface ParentContextInheritanceResult {
	readonly kind: "result";
	readonly purpose: "inheritance";
	readonly payload: string;
}
export interface ParentContextHandoffResult {
	readonly kind: "result";
	readonly purpose: "handoff";
	readonly install: (
		destination: Pick<SessionManager, "getSessionId" | "getBranch" | "appendCustomMessageEntry">,
		signal: AbortSignal,
	) => Promise<void>;
}
export type ParentContextProjectionResult =
	| ParentContextProjectionUnavailable
	| ParentContextProjectionStale
	| ParentContextInheritanceResult
	| ParentContextHandoffResult;
export interface ParentContextProjectionPrepareInput {
	readonly purpose: ParentContextProjectionPurpose;
	readonly signal: AbortSignal;
}
export interface ParentContextProjectionService {
	prepare(input: ParentContextProjectionPrepareInput): Promise<ParentContextProjectionResult>;
}

/** Runtime-scoped capability for validated parent-context projections. */
export const PARENT_CONTEXT_PROJECTION_SERVICE = createServiceKey<ParentContextProjectionService>(
	"@hheei/pi-mctx/context-projection@1",
);
