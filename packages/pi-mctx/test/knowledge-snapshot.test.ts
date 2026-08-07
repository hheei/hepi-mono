import { expect, test } from "bun:test";
import type { KnowledgeProjectionIdentity, KnowledgeProjectionSource } from "@hheei/pi-ext-core";
import {
	createKnowledgeSnapshotDraft,
	isKnowledgeSnapshotFreshForReplay,
	knowledgeIdentityMatches,
	knowledgeSnapshotMessage,
	renderKnowledgeSources,
} from "../src/knowledge-snapshot.js";

const identity: KnowledgeProjectionIdentity = {
	projectIdentity: "git:project",
	bankIds: ["project-bank"],
	scopeTags: ["project:project"],
	memoryProfile: "project-only",
	capabilityRevision: "hindsight-client:1",
	policyVersion: "policy-1",
	epoch: "persistent",
};

function source(overrides: Partial<KnowledgeProjectionSource> = {}): KnowledgeProjectionSource {
	return {
		id: "mental-model:architecture",
		kind: "mental-model",
		title: "Architecture",
		text: "Keep lifecycle and storage boundaries explicit.",
		sourceVersion: "version-1",
		provenance: ["bank:project-bank", "mental-model:architecture"],
		scopeTags: ["project:project"],
		...overrides,
	};
}

test("renders bounded knowledge and marks injected sources as non-retainable", (): void => {
	const draft = createKnowledgeSnapshotDraft(
		{ identity, freshness: "fresh", sources: [source()] },
		"git:project",
		240,
		123,
	);
	expect(draft.renderedPayload.length).toBeLessThanOrEqual(240);
	const message = knowledgeSnapshotMessage({ revision: 1, ...draft });
	expect(message).toMatchObject({
		role: "custom",
		customType: "pi-injected-knowledge",
		display: true,
		details: { provider: "hindsight", sourceIds: ["mental-model:architecture"], retain: false },
	});
});

test("rejects duplicate, out-of-scope, and malformed projection sources", (): void => {
	const duplicate = source({ id: "mental-model:other" });
	expect(() =>
		createKnowledgeSnapshotDraft(
			{ identity, freshness: "fresh", sources: [source(), duplicate] },
			"git:project",
			1000,
		),
	).toThrow("projection source is invalid");
	expect(() =>
		createKnowledgeSnapshotDraft(
			{
				identity,
				freshness: "fresh",
				sources: [source({ scopeTags: ["project:other"] })],
			},
			"git:project",
			1000,
		),
	).toThrow("projection source is invalid");
	expect(() =>
		createKnowledgeSnapshotDraft(
			{ identity, freshness: "fresh", sources: [source({ provenance: [] })] },
			"git:project",
			1000,
		),
	).toThrow("projection source is invalid");
});

test("requires complete identity equality for fresh replay", (): void => {
	expect(knowledgeIdentityMatches(identity, { ...identity })).toBe(true);
	expect(knowledgeIdentityMatches(identity, { ...identity, policyVersion: "policy-2" })).toBe(
		false,
	);
	const snapshot = createKnowledgeSnapshotDraft(
		{ identity, freshness: "unknown", sources: [source()] },
		"git:project",
		1000,
	);
	expect(isKnowledgeSnapshotFreshForReplay({ revision: 1, ...snapshot }, identity)).toBe(true);
	expect(
		isKnowledgeSnapshotFreshForReplay({ revision: 1, ...snapshot, freshness: "stale" }, identity),
	).toBe(false);
});

test("keeps render budget bounded even when wrapper overhead consumes it", (): void => {
	expect(renderKnowledgeSources([source()], 1)).toBe("");
});
