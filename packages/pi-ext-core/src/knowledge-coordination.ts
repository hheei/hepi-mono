import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionLifecycleContext } from "./lifecycle.js";
import { createServiceKey, getService, provideService } from "./service.js";

export type KnowledgeInjectionOwner = "unknown" | "mctx-owned" | "hindsight-owned" | "disabled";

export interface KnowledgeInjectionLease {
	readonly owner: Exclude<KnowledgeInjectionOwner, "unknown">;
	readonly generation: string;
	readonly token: string;
}

export interface KnowledgeInjectionState {
	readonly owner: KnowledgeInjectionOwner;
	readonly generation?: string;
	readonly reason?: string;
	readonly mctxEligible: boolean;
}

export interface KnowledgeInjectionCoordinator {
	state(): KnowledgeInjectionState;
	setMctxEligibility(input: { readonly generation: string; readonly eligible: boolean }): void;
	disable(input: { readonly generation: string; readonly reason: string }): void;
	claim(input: {
		readonly owner: "mctx-owned" | "hindsight-owned";
		readonly generation: string;
		readonly reason: string;
	}): KnowledgeInjectionLease | undefined;
	release(lease: KnowledgeInjectionLease): boolean;
}

export const KNOWLEDGE_INJECTION_COORDINATOR = createServiceKey<KnowledgeInjectionCoordinator>(
	"hheei/knowledge-injection-coordinator",
);

export type KnowledgeSourceKind =
	| "mental-model"
	| "observation"
	| "reflect"
	| "knowledge-page-section";

export interface KnowledgeProjectionSource {
	readonly id: string;
	readonly kind: KnowledgeSourceKind;
	readonly title: string;
	readonly text: string;
	readonly sourceVersion: string;
	readonly provenance: readonly string[];
	readonly scopeTags: readonly string[];
	readonly updatedAt?: string;
}

export interface KnowledgeProjectionIdentity {
	readonly projectIdentity: string;
	readonly bankIds: readonly string[];
	readonly scopeTags: readonly string[];
	readonly memoryProfile: string;
	readonly capabilityRevision: string;
	readonly policyVersion: string;
	readonly epoch: string;
}

export interface KnowledgeProjectionRequest {
	readonly projectIdentity: string;
	readonly maxChars: number;
	readonly signal: AbortSignal;
	readonly sessionFile?: string;
	readonly query?: string;
	readonly mode: "baseline" | "delta" | "turn-local";
}

export type KnowledgeProjectionIdentityRequest = Pick<
	KnowledgeProjectionRequest,
	"projectIdentity" | "query" | "mode"
> & { readonly sessionFile?: string };

export type KnowledgeProjectionAdmission =
	| { readonly kind: "allowed"; readonly identity: KnowledgeProjectionIdentity }
	| { readonly kind: "denied"; readonly reason: string };

export interface KnowledgeProjectionResult {
	readonly identity: KnowledgeProjectionIdentity;
	readonly freshness: "fresh" | "unknown" | "stale";
	readonly sources: readonly KnowledgeProjectionSource[];
}

export interface HindsightKnowledgeProvider {
	/** Reads current local policy/session mode without fetching knowledge content. */
	identity(request: KnowledgeProjectionIdentityRequest): Promise<KnowledgeProjectionAdmission>;
	project(request: KnowledgeProjectionRequest): Promise<KnowledgeProjectionResult>;
}

export const HINDSIGHT_KNOWLEDGE_PROVIDER = createServiceKey<HindsightKnowledgeProvider>(
	"hheei/hindsight-knowledge-provider",
);

/** One bounded, already-rendered section from a Hindsight knowledge page. */
export interface KnowledgeSection {
	readonly id: string;
	readonly pageId: string;
	readonly pageName: string;
	readonly heading: string;
	readonly text: string;
	readonly sourceVersion: string;
	readonly provenance: readonly string[];
	readonly scopeTags: readonly string[];
	readonly updatedAt?: string;
}

/**
 * Reads a provider-owned page cache for MCTX turn-local selection.
 * Implementations MUST NOT perform remote I/O in this method: refresh happens
 * in the owning extension's lifecycle/background path.
 */
export interface PageSectionService {
	getPageSections(input: {
		readonly lease: KnowledgeInjectionLease;
		readonly projectId: string;
		readonly signal: AbortSignal;
	}): Promise<
		| {
				readonly kind: "sections";
				readonly version?: string;
				readonly sections: readonly KnowledgeSection[];
		  }
		| { readonly kind: "unsupported" }
		| { readonly kind: "unavailable"; readonly reason: string }
	>;
}

export const HINDSIGHT_PAGE_SECTION_SERVICE = createServiceKey<PageSectionService>(
	"hheei/hindsight-page-section-service",
);

export interface InjectedKnowledgeMarker {
	readonly provider: "hindsight";
	readonly sourceIds: readonly string[];
	readonly retain: false;
}

export const INJECTED_KNOWLEDGE_MARKER = "pi-injected-knowledge";

export function injectedKnowledgeMarker(sourceIds: readonly string[]): InjectedKnowledgeMarker {
	const unique = [...new Set(sourceIds.filter((sourceId) => sourceId.trim().length > 0))];
	return { provider: "hindsight", sourceIds: unique, retain: false };
}

export function isInjectedKnowledgeMarker(value: unknown): value is InjectedKnowledgeMarker {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.provider === "hindsight" &&
		record.retain === false &&
		record.sourceIds !== undefined &&
		Array.isArray(record.sourceIds) &&
		record.sourceIds.every((sourceId) => typeof sourceId === "string")
	);
}

export function isInjectedKnowledgeMessage(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.customType === INJECTED_KNOWLEDGE_MARKER) return true;
	return isInjectedKnowledgeMarker(record.details);
}

export function ensureKnowledgeInjectionCoordinator(
	pi: ExtensionAPI,
	context: ExtensionLifecycleContext,
): KnowledgeInjectionCoordinator {
	const existing = getService(pi, KNOWLEDGE_INJECTION_COORDINATOR);
	if (existing !== undefined) return existing;
	const created = createKnowledgeInjectionCoordinator();
	if (provideService(context, KNOWLEDGE_INJECTION_COORDINATOR, created)) return created;
	const raced = getService(pi, KNOWLEDGE_INJECTION_COORDINATOR);
	if (raced !== undefined) return raced;
	throw new Error("Knowledge injection coordinator registration failed");
}

export function getKnowledgeInjectionCoordinator(
	pi: ExtensionAPI,
): KnowledgeInjectionCoordinator | undefined {
	return getService(pi, KNOWLEDGE_INJECTION_COORDINATOR);
}

function createKnowledgeInjectionCoordinator(): KnowledgeInjectionCoordinator {
	let current: KnowledgeInjectionLease | undefined;
	let reason: string | undefined;
	let mctxEligibility: { readonly generation: string; readonly eligible: boolean } | undefined;
	return {
		state(): KnowledgeInjectionState {
			return {
				owner: current?.owner ?? "unknown",
				...(current === undefined ? {} : { generation: current.generation }),
				...(reason === undefined ? {} : { reason }),
				mctxEligible: mctxEligibility?.eligible === true,
			};
		},
		setMctxEligibility(input): void {
			if (!input.generation.trim()) return;
			if (
				!input.eligible &&
				current?.owner === "disabled" &&
				current.generation === input.generation
			) {
				current = undefined;
				reason = undefined;
			}
			if (current !== undefined && current.generation !== input.generation) {
				if (current.owner !== "disabled") return;
				current = undefined;
				reason = undefined;
			}
			mctxEligibility = input;
		},
		disable(input): void {
			if (!input.generation.trim() || !input.reason.trim()) return;
			if (current !== undefined && current.generation !== input.generation) return;
			current = { owner: "disabled", generation: input.generation, token: randomUUID() };
			reason = input.reason;
		},
		claim(input): KnowledgeInjectionLease | undefined {
			if (!input.generation.trim() || !input.reason.trim()) return undefined;
			if (input.owner === "hindsight-owned" && mctxEligibility?.eligible === true) return undefined;
			if (current !== undefined) return undefined;
			const lease: KnowledgeInjectionLease = {
				owner: input.owner,
				generation: input.generation,
				token: randomUUID(),
			};
			current = lease;
			reason = input.reason;
			return lease;
		},
		release(lease): boolean {
			if (current?.token !== lease.token) return false;
			current = undefined;
			reason = undefined;
			return true;
		},
	};
}
