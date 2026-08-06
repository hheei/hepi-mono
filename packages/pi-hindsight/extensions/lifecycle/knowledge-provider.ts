import { createHash } from "node:crypto";
import type {
	HindsightKnowledgeProvider,
	KnowledgeProjectionAdmission,
	KnowledgeProjectionIdentity,
	KnowledgeProjectionIdentityRequest,
	KnowledgeProjectionRequest,
	KnowledgeProjectionResult,
	KnowledgeProjectionSource,
} from "@hheei/pi-ext-core";
import { HINDSIGHT_CLIENT_VERSION } from "../client/client.js";
import { createMemoryIdentity } from "../operations/memory-identity.js";
import {
	composeScopedTagFilter,
	scopeTagsForBank,
	selectMemoryScopes,
} from "../operations/memory-scope.js";
import type { HindsightLikeClient, ResolvedConfig } from "../types.js";
import {
	getEffectiveSessionMemoryMode,
	readSessionMemoryMeta,
} from "../utils/session-memory-meta.js";
import { loadMentalModelSources } from "./mental-models.js";

export interface HindsightKnowledgeProviderDeps {
	getClient(): HindsightLikeClient;
	getConfig(): ResolvedConfig;
	getProjectBankId(): string;
	getCwd(): string;
}

const KNOWLEDGE_POLICY_VERSION = "mctx-hindsight-reflect-observation-v1";
const REFLECT_MAX_TOKENS = 512;
const OBSERVATION_MAX_TOKENS = 320;
const MAX_REFLECT_TEXT_CHARS = 8_000;
const MAX_OBSERVATIONS = 32;
const MAX_OBSERVATION_TEXT_CHARS = 4_000;
const MAX_OBSERVATION_TOTAL_CHARS = 12_000;
const MAX_OBSERVATION_ID_CHARS = 512;
const MAX_OBSERVATION_TAGS = 32;
const MAX_REFLECT_MEMORIES = 32;
const KNOWLEDGE_QUERY = "Compile durable project knowledge, decisions, and engineering conventions";

interface ValidReflect {
	readonly text: string;
	readonly memoryIds: readonly string[];
}

function normalizeKnowledgeText(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

function responseRecord(response: unknown): Record<string, unknown> | undefined {
	return response !== null && typeof response === "object" && !Array.isArray(response)
		? (response as Record<string, unknown>)
		: undefined;
}

function responseText(response: unknown): string | undefined {
	const record = responseRecord(response);
	if (record === undefined) return undefined;
	for (const key of ["text", "content", "answer"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function validReflect(
	response: unknown,
	observationTexts: ReadonlyMap<string, string>,
): ValidReflect {
	const record = responseRecord(response);
	const text = responseText(response);
	const basedOn = responseRecord(record?.based_on);
	const memories = basedOn?.memories;
	if (
		record === undefined ||
		text === undefined ||
		text.length > MAX_REFLECT_TEXT_CHARS ||
		!Array.isArray(memories) ||
		memories.length === 0 ||
		memories.length > MAX_REFLECT_MEMORIES
	)
		throw new Error("Hindsight reflect response is invalid or lacks provenance");
	const ids = new Set<string>();
	let evidenceChars = 0;
	for (const value of memories) {
		if (value === null || typeof value !== "object" || Array.isArray(value))
			throw new Error("Hindsight reflect provenance is malformed");
		const memory = value as Record<string, unknown>;
		const id = memory.id;
		const memoryText = memory.text;
		const type = memory.type;
		const normalizedId = typeof id === "string" ? id.trim() : "";
		const normalizedText = typeof memoryText === "string" ? normalizeKnowledgeText(memoryText) : "";
		if (
			typeof id !== "string" ||
			!id.trim() ||
			id.length > MAX_OBSERVATION_ID_CHARS ||
			typeof memoryText !== "string" ||
			!memoryText.trim() ||
			memoryText.length > MAX_OBSERVATION_TEXT_CHARS ||
			type !== "observation" ||
			!observationTexts.has(normalizedId) ||
			observationTexts.get(normalizedId) !== normalizedText ||
			ids.has(normalizedId)
		)
			throw new Error(
				observationTexts.has(normalizedId) && observationTexts.get(normalizedId) !== normalizedText
					? "Hindsight reflect provenance text mismatch"
					: "Hindsight reflect provenance is malformed or out of scope",
			);
		ids.add(normalizedId);
		evidenceChars += memoryText.length;
	}
	if (evidenceChars > MAX_OBSERVATION_TOTAL_CHARS)
		throw new Error("Hindsight reflect provenance exceeds limit");
	return { text, memoryIds: [...ids] };
}

interface ValidObservation {
	readonly id: string;
	readonly text: string;
	readonly tags: readonly string[];
	readonly sourceVersion: string;
}

function responseItems(
	response: unknown,
	scopeTags: readonly string[],
	allowShared: boolean,
): readonly ValidObservation[] {
	const record = responseRecord(response);
	if (record === undefined) throw new Error("Hindsight recall response is invalid");
	const raw = Array.isArray(record.results)
		? record.results
		: Array.isArray(record.memories)
			? record.memories
			: undefined;
	if (raw === undefined || raw.length > MAX_OBSERVATIONS)
		throw new Error("Hindsight observation payload is invalid or exceeds limit");
	const ids = new Set<string>();
	let totalChars = 0;
	return raw.map((value): ValidObservation => {
		if (value === null || typeof value !== "object" || Array.isArray(value))
			throw new Error("Hindsight observation item is invalid");
		const item = value as Record<string, unknown>;
		const id = item.id;
		const text = item.text;
		const tags = item.tags;
		if (
			typeof id !== "string" ||
			!id.trim() ||
			typeof text !== "string" ||
			!text.trim() ||
			text.length > MAX_OBSERVATION_TEXT_CHARS ||
			id.length > MAX_OBSERVATION_ID_CHARS ||
			!Array.isArray(tags) ||
			tags.length > MAX_OBSERVATION_TAGS ||
			!tags.every((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
		)
			throw new Error("Hindsight observation item is malformed");
		if (ids.has(id.trim())) throw new Error("Hindsight observation ids are duplicated");
		const normalizedTags = tags.map((tag) => tag.trim());
		if (
			!normalizedTags.some((tag) => scopeTags.includes(tag)) &&
			!(allowShared && normalizedTags.length === 0)
		)
			throw new Error("Hindsight observation scope mismatch");
		totalChars += text.length;
		if (totalChars > MAX_OBSERVATION_TOTAL_CHARS)
			throw new Error("Hindsight observation payload exceeds limit");
		ids.add(id.trim());
		return {
			id: id.trim(),
			text: normalizeKnowledgeText(text),
			tags: normalizedTags,
			sourceVersion: responseItemVersion(item, normalizeKnowledgeText(text)),
		};
	});
}

function responseItemVersion(item: Record<string, unknown>, text: string): string {
	const metadata = responseRecord(item.metadata);
	for (const value of [item.updated_at, item.updatedAt, metadata?.version]) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(item) || text)
		.digest("hex")}`;
}

function memoryProfile(config: ResolvedConfig): string {
	if (!config.banks.project.enabled) return config.banks.user.enabled ? "global-only" : "none";
	return config.banks.user.enabled ? "project+global" : "project-only";
}

function projectionScope(
	deps: HindsightKnowledgeProviderDeps,
	config: ResolvedConfig,
): {
	readonly identity: ReturnType<typeof createMemoryIdentity>;
	readonly scopes: ReturnType<typeof selectMemoryScopes>;
	readonly scopeTags: readonly string[];
} {
	const identity = createMemoryIdentity(deps.getCwd(), config);
	const scopes = selectMemoryScopes(deps.getCwd(), config).filter(
		(scope) => scope.bankId === deps.getProjectBankId() || scope.kind === "global",
	);
	return {
		identity,
		scopes,
		scopeTags: [
			...new Set(scopes.flatMap((scope) => scopeTagsForBank(deps.getCwd(), config, scope.bankId))),
		],
	};
}

function projectionIdentity(
	deps: HindsightKnowledgeProviderDeps,
	config: ResolvedConfig,
	request: KnowledgeProjectionIdentityRequest,
): KnowledgeProjectionIdentity {
	const scope = projectionScope(deps, config);
	return {
		projectIdentity: request.projectIdentity,
		bankIds: scope.scopes.map((current) => current.bankId),
		scopeTags: scope.scopeTags,
		memoryProfile: memoryProfile(config),
		capabilityRevision: `hindsight-client:${HINDSIGHT_CLIENT_VERSION}`,
		policyVersion: KNOWLEDGE_POLICY_VERSION,
		epoch: request.query?.trim() || "persistent",
	};
}

async function projectionAdmission(
	deps: HindsightKnowledgeProviderDeps,
	request: KnowledgeProjectionIdentityRequest,
): Promise<KnowledgeProjectionAdmission> {
	const sessionMode = getEffectiveSessionMemoryMode(
		await readSessionMemoryMeta(deps.getCwd(), request.sessionFile),
	);
	if (!sessionMode.recall)
		return {
			kind: "denied",
			reason:
				sessionMode.mode === "ignored"
					? "Hindsight session mode is ignored"
					: "Hindsight recall is disabled for this session",
		};
	return { kind: "allowed", identity: projectionIdentity(deps, deps.getConfig(), request) };
}

export function createHindsightKnowledgeProvider(
	deps: HindsightKnowledgeProviderDeps,
): HindsightKnowledgeProvider {
	return {
		async identity(
			request: KnowledgeProjectionIdentityRequest,
		): Promise<KnowledgeProjectionAdmission> {
			return projectionAdmission(deps, request);
		},
		async project(request: KnowledgeProjectionRequest): Promise<KnowledgeProjectionResult> {
			if (request.mode !== "baseline")
				throw new Error("Hindsight mental-model provider only supports baseline projection");
			if (!Number.isSafeInteger(request.maxChars) || request.maxChars <= 0)
				throw new Error("Hindsight knowledge projection budget is invalid");
			const config = deps.getConfig();
			const admission = await projectionAdmission(deps, request);
			if (admission.kind === "denied") throw new Error(admission.reason);
			const scope = projectionScope(deps, config);
			const sourceGroups: KnowledgeProjectionSource[][] = [];
			let failed = false;
			for (const current of scope.scopes) {
				request.signal.throwIfAborted();
				const scopeTags = scopeTagsForBank(deps.getCwd(), config, current.bankId);
				const scopedFilter = composeScopedTagFilter(scopeTags, {
					includeSharedObservations:
						current.kind === "project" && config.scope.includeSharedObservations,
				});
				const loaded = await loadMentalModelSources({
					client: deps.getClient(),
					config,
					bankId: current.bankId,
					bankKind: current.kind === "global" ? "user" : "project",
					...(current.kind === "project" ? { projectId: scope.identity.projectId } : {}),
					signal: request.signal,
				});
				if (loaded.error) failed = true;
				const sources: KnowledgeProjectionSource[] = loaded.models.map((model) => ({
					id: `mental-model:${current.bankId}:${model.id}`,
					kind: "mental-model" as const,
					title: model.name,
					text: model.content?.trim() ?? "",
					sourceVersion:
						model.lastRefreshedAt ??
						`sha256:${createHash("sha256")
							.update(model.content?.trim() ?? "")
							.digest("hex")}`,
					provenance: [`bank:${current.bankId}`, `mental-model:${model.id}`],
					scopeTags,
					...(model.lastRefreshedAt ? { updatedAt: model.lastRefreshedAt } : {}),
				}));
				const observationTexts = new Map<string, string>();
				// Same bounded query lets reflect citations be checked against recalled IDs and normalized text; never trust unknown evidence.
				const recalled = await deps.getClient().recall(current.bankId, KNOWLEDGE_QUERY, {
					types: ["observation"],
					preferObservations: true,
					maxTokens: OBSERVATION_MAX_TOKENS,
					budget: "low",
					includeSourceFacts: false,
					...("tagGroups" in scopedFilter ? scopedFilter : {}),
					signal: request.signal,
				});
				for (const item of responseItems(
					recalled,
					scopeTags,
					current.kind === "project" && config.scope.includeSharedObservations,
				)) {
					observationTexts.set(item.id, item.text);
					sources.push({
						id: `observation:${current.bankId}:${item.id}`,
						kind: "observation",
						title: "Observation",
						text: item.text,
						sourceVersion: item.sourceVersion,
						provenance: [
							`bank:${current.bankId}`,
							`observation:${item.id}`,
							`tags:${item.tags.join(",")}`,
						],
						scopeTags,
					});
				}
				const reflected = await deps.getClient().reflect(current.bankId, KNOWLEDGE_QUERY, {
					context: "MCTX hard knowledge materialization",
					budget: "low",
					maxTokens: REFLECT_MAX_TOKENS,
					includeFacts: true,
					includeToolCalls: false,
					factTypes: ["observation"],
					excludeMentalModels: true,
					...("tagGroups" in scopedFilter ? scopedFilter : {}),
					signal: request.signal,
				});
				const reflectedResult = validReflect(reflected, observationTexts);
				const reflectedVersion = createHash("sha256")
					.update(JSON.stringify(reflectedResult))
					.digest("hex");
				sources.push({
					id: `reflect:${current.bankId}:${reflectedVersion}`,
					kind: "reflect",
					title: "Reflect baseline",
					text: reflectedResult.text,
					sourceVersion: `sha256:${reflectedVersion}`,
					provenance: [
						`bank:${current.bankId}`,
						"reflect:mctx-hard-materialization",
						...reflectedResult.memoryIds.map((id) => `memory:${id}`),
					],
					scopeTags,
				});
				sourceGroups.push(sources);
			}
			const sourceIds = new Set<string>();
			const provenances = new Set<string>();
			const contents = new Set<string>();
			const sources = sourceGroups.flat().filter((source) => {
				const text = source.text.trim();
				const provenance = JSON.stringify(source.provenance);
				if (
					text.length === 0 ||
					sourceIds.has(source.id) ||
					provenances.has(provenance) ||
					contents.has(text)
				)
					return false;
				sourceIds.add(source.id);
				provenances.add(provenance);
				contents.add(text);
				return true;
			});
			const limited: KnowledgeProjectionSource[] = [];
			let used = 0;
			for (const source of sources) {
				if (used >= request.maxChars) break;
				const room = request.maxChars - used;
				const text = source.text.slice(0, room);
				if (!text) continue;
				limited.push(text.length === source.text.length ? source : { ...source, text });
				used += text.length;
			}
			return {
				identity: admission.identity,
				freshness: failed ? "unknown" : "fresh",
				sources: limited,
			};
		},
	};
}
