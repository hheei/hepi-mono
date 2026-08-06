import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../extensions/config/config.js";
import { createHindsightKnowledgeProvider } from "../extensions/lifecycle/knowledge-provider.js";
import { scopeTagsForBank } from "../extensions/operations/memory-scope.js";
import type { HindsightLikeClient, ResolvedConfig } from "../extensions/types.js";
import { setSessionMemoryMode } from "../extensions/utils/session-memory-meta.js";

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...DEFAULT_CONFIG,
		setupComplete: true,
		banks: {
			...DEFAULT_CONFIG.banks,
			project: { ...DEFAULT_CONFIG.banks.project, bankId: "project-bank", derive: "manual" },
		},
		...overrides,
	};
}

function providerFixture(
	configValue: ResolvedConfig,
	listMentalModels: NonNullable<HindsightLikeClient["listMentalModels"]>,
	reflectResponse: unknown = {
		text: "Keep durable project decisions.",
		based_on: {
			memories: [{ id: "observation-1", text: "Use explicit ownership.", type: "observation" }],
		},
	},
) {
	const scopeTag = scopeTagsForBank("/repo", configValue, "project-bank")[0];
	if (scopeTag === undefined) throw new Error("Expected project scope tag");
	return createHindsightKnowledgeProvider({
		getClient: () => ({
			retain: async () => undefined,
			recall: async () => ({
				results: [{ id: "observation-1", text: "Use explicit ownership.", tags: [scopeTag] }],
			}),
			reflect: async () => reflectResponse,
			listMentalModels,
		}),
		getConfig: () => configValue,
		getProjectBankId: () => "project-bank",
		getCwd: () => "/repo",
	});
}

describe("MCTX knowledge provider", () => {
	it("projects scoped mental models with stable source metadata and deduplication", async () => {
		const listMentalModels = vi.fn(async () => ({
			items: [
				{
					id: "architecture",
					name: "Architecture",
					content: "Keep ownership boundaries explicit.",
					tags: ["source:pi"],
				},
				{
					id: "duplicate",
					name: "Duplicate",
					content: "Keep ownership boundaries explicit.",
					tags: ["source:pi"],
				},
				{
					id: "other-project",
					name: "Other project",
					content: "Must not cross project scope.",
					tags: ["source:pi", "project:other"],
				},
			],
		}));
		const provider = providerFixture(config(), listMentalModels);
		const admission = await provider.identity({ projectIdentity: "git:project", mode: "baseline" });
		expect(admission.kind).toBe("allowed");
		if (admission.kind !== "allowed") throw new Error("Expected knowledge admission");
		const result = await provider.project({
			projectIdentity: "git:project",
			maxChars: 2000,
			signal: new AbortController().signal,
			mode: "baseline",
		});
		expect(result.identity).toEqual(admission.identity);
		expect(result.freshness).toBe("fresh");
		expect(result.sources.map((source) => source.id)).toEqual([
			"mental-model:project-bank:architecture",
			"observation:project-bank:observation-1",
			"reflect:project-bank:8982488d0a9d619d6f1c543f0a8cd5cf827edadf6887c6be5c44604e3e7f6b9f",
		]);
		expect(result.sources[0]?.provenance).toEqual([
			"bank:project-bank",
			"mental-model:architecture",
		]);
		expect(result.sources[2]?.provenance).toContain("memory:observation-1");
		expect(listMentalModels).toHaveBeenCalledWith(
			"project-bank",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("compiles only scoped observations with stable server provenance", async () => {
		const configValue = config();
		const scopeTag = scopeTagsForBank("/repo", configValue, "project-bank")[0];
		if (scopeTag === undefined) throw new Error("Expected project scope tag");
		const recall = vi.fn(async () => ({
			results: [{ id: "observation-1", text: "Use strict boundaries.", tags: [scopeTag] }],
		}));
		const reflect = vi.fn(async () => ({
			text: "Durable project conventions.",
			based_on: {
				memories: [
					{ id: "observation-1", text: "Use   strict\n boundaries.", type: "observation" },
				],
			},
		}));
		const provider = createHindsightKnowledgeProvider({
			getClient: () => ({
				retain: async () => undefined,
				recall,
				reflect,
				listMentalModels: async () => ({ items: [] }),
			}),
			getConfig: () => configValue,
			getProjectBankId: () => "project-bank",
			getCwd: () => "/repo",
		});
		const result = await provider.project({
			projectIdentity: "git:project",
			maxChars: 2000,
			signal: new AbortController().signal,
			mode: "baseline",
		});
		expect(result.sources.find((source) => source.kind === "observation")).toMatchObject({
			id: "observation:project-bank:observation-1",
			text: "Use strict boundaries.",
			provenance: ["bank:project-bank", "observation:observation-1", `tags:${scopeTag}`],
		});
		expect(result.sources.find((source) => source.kind === "reflect")?.provenance).toContain(
			"memory:observation-1",
		);
		expect(recall).toHaveBeenCalledWith(
			"project-bank",
			"Compile durable project knowledge, decisions, and engineering conventions",
			expect.objectContaining({
				types: ["observation"],
				preferObservations: true,
				maxTokens: 320,
			}),
		);
		expect(reflect).toHaveBeenCalledWith(
			"project-bank",
			"Compile durable project knowledge, decisions, and engineering conventions",
			expect.objectContaining({
				includeFacts: true,
				factTypes: ["observation"],
				excludeMentalModels: true,
			}),
		);
	});

	it("rejects malformed, duplicate, oversized, and cross-scope observations", async () => {
		const configValue = config();
		const scopeTag = scopeTagsForBank("/repo", configValue, "project-bank")[0];
		if (scopeTag === undefined) throw new Error("Expected project scope tag");
		const valid = { id: "observation-1", text: "Scoped observation.", tags: [scopeTag] };
		const cases: ReadonlyArray<{
			name: string;
			response: unknown;
			error: string;
		}> = [
			{
				name: "missing id",
				response: { results: [{ text: valid.text, tags: valid.tags }] },
				error: "malformed",
			},
			{
				name: "missing text",
				response: { results: [{ id: valid.id, tags: valid.tags }] },
				error: "malformed",
			},
			{
				name: "missing tags",
				response: { results: [{ id: valid.id, text: valid.text }] },
				error: "malformed",
			},
			{
				name: "duplicate id",
				response: { results: [valid, { ...valid, text: "Same id" }] },
				error: "duplicated",
			},
			{
				name: "oversized text",
				response: { results: [{ ...valid, text: "x".repeat(4_001) }] },
				error: "malformed",
			},
			{
				name: "wrong scope",
				response: { results: [{ ...valid, tags: ["project:other"] }] },
				error: "scope mismatch",
			},
		];
		for (const current of cases) {
			const provider = createHindsightKnowledgeProvider({
				getClient: () => ({
					retain: async () => undefined,
					recall: async () => current.response,
					reflect: async () => ({
						text: "Should not be used.",
						based_on: { memories: [{ id: "observation-1", text: "x", type: "observation" }] },
					}),
					listMentalModels: async () => ({ items: [] }),
				}),
				getConfig: () => configValue,
				getProjectBankId: () => "project-bank",
				getCwd: () => "/repo",
			});
			await expect(
				provider.project({
					projectIdentity: "git:project",
					maxChars: 2000,
					signal: new AbortController().signal,
					mode: "baseline",
				}),
			).rejects.toThrow(current.error);
		}
	});

	it("rejects reflect responses without based_on provenance", async () => {
		const provider = providerFixture(
			config(),
			vi.fn(async () => ({ items: [] })),
			{ text: "Ungrounded reflect" },
		);
		await expect(
			provider.project({
				projectIdentity: "git:project",
				maxChars: 2000,
				signal: new AbortController().signal,
				mode: "baseline",
			}),
		).rejects.toThrow("lacks provenance");
	});

	it("rejects reflect evidence not returned as scoped observations", async () => {
		const configValue = config();
		const scopeTag = scopeTagsForBank("/repo", configValue, "project-bank")[0];
		if (scopeTag === undefined) throw new Error("Expected project scope tag");
		const responses: ReadonlyArray<{
			memory: { id: string; text: string; type: string };
			error: string;
		}> = [
			{
				memory: { id: "unknown", text: "Unknown evidence.", type: "observation" },
				error: "out of scope",
			},
			{
				memory: { id: "observation-1", text: "Scoped observation.", type: "world" },
				error: "out of scope",
			},
			{
				memory: { id: "observation-1", text: "Different evidence.", type: "observation" },
				error: "text mismatch",
			},
		];
		for (const current of responses) {
			const provider = createHindsightKnowledgeProvider({
				getClient: () => ({
					retain: async () => undefined,
					recall: async () => ({
						results: [{ id: "observation-1", text: "Scoped observation.", tags: [scopeTag] }],
					}),
					reflect: async () => ({ text: "Reflect.", based_on: { memories: [current.memory] } }),
					listMentalModels: async () => ({ items: [] }),
				}),
				getConfig: () => configValue,
				getProjectBankId: () => "project-bank",
				getCwd: () => "/repo",
			});
			await expect(
				provider.project({
					projectIdentity: "git:project",
					maxChars: 2000,
					signal: new AbortController().signal,
					mode: "baseline",
				}),
			).rejects.toThrow(current.error);
		}
	});

	it("fails closed for ignored sessions and unsupported projection modes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-hindsight-provider-"));
		try {
			const sessionFile = join(directory, "session.jsonl");
			await setSessionMemoryMode(directory, sessionFile, "ignored");
			const provider = createHindsightKnowledgeProvider({
				getClient: () => ({
					retain: async () => undefined,
					recall: async () => [],
					reflect: async () => ({}),
				}),
				getConfig: () => config(),
				getProjectBankId: () => "project-bank",
				getCwd: () => directory,
			});
			expect(
				await provider.identity({
					projectIdentity: "git:project",
					mode: "baseline",
					sessionFile,
				}),
			).toEqual({ kind: "denied", reason: "Hindsight session mode is ignored" });
			await expect(
				provider.project({
					projectIdentity: "git:project",
					maxChars: 100,
					signal: new AbortController().signal,
					mode: "turn-local",
				}),
			).rejects.toThrow("only supports baseline projection");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
