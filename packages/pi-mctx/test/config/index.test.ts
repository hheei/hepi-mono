import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getRuntimeSettingsRegistry } from "@hheei/pi-ext-core";
import { describe, expect, it } from "vitest";
import { MagicContextConfigSchema } from "#core/config/schema/magic-context";
import {
	createPiMctxSettingsProvider,
	loadPiConfig,
	PI_MCTX_SETTINGS_GROUP,
	PI_MCTX_SETTINGS_PROVIDER_ID,
	registerPiMctxSettings,
	resetPiMctxConfigForReload,
	resolvePiMctxSettings,
} from "../../src/config/index";

const defaults = MagicContextConfigSchema.parse({});

describe("Pi MCTX settings", () => {
	it("maps flat memory, historian, and Dreamer settings into the runtime schema", () => {
		const config = resolvePiMctxSettings({
			[PI_MCTX_SETTINGS_GROUP]: {
				enabled: false,
				compactionEnabled: false,
				systemPromptInjection: false,
				temporalAwareness: false,
				memoryEnabled: false,
				memoryInjectionBudgetTokens: 8_000,
				memoryAutoPromote: false,
				memoryRetrievalPromotionThreshold: 6,
				memoryAutoSearchEnabled: false,
				memoryAutoSearchScoreThreshold: 0.8,
				memoryAutoSearchMinPromptChars: 80,
				memoryGitCommitIndexingEnabled: true,
				memoryGitCommitSinceDays: 30,
				memoryGitCommitMaxCommits: 500,
				historianEnabled: false,
				historianModel: "github-copilot/gpt-5.4",
				historianTwoPass: true,
				historianTimeoutMs: 600_000,
				historyBudgetPercentage: 0.2,
				commitClusterTriggerEnabled: false,
				commitClusterMinClusters: 5,
				sidekickModel: "openai/gpt-5-mini",
			},
		});

		expect(config.enabled).toBe(false);
		expect(config.compaction.enabled).toBe(false);
		expect(config.system_prompt_injection.enabled).toBe(false);
		expect(config.temporal_awareness).toBe(false);
		expect(config.memory).toMatchObject({
			enabled: false,
			injection_budget_tokens: 8_000,
			auto_promote: false,
			retrieval_count_promotion_threshold: 6,
			auto_search: { enabled: false, score_threshold: 0.8, min_prompt_chars: 80 },
			git_commit_indexing: { enabled: true, since_days: 30, max_commits: 500 },
		});
		expect(config.historian).toMatchObject({
			disable: true,
			model: "github-copilot/gpt-5.4",
			two_pass: true,
		});
		expect(config.historian_timeout_ms).toBe(600_000);
		expect(config.history_budget_percentage).toBe(0.2);
		expect(config.commit_cluster_trigger).toEqual({ enabled: false, min_clusters: 5 });
		expect(config.sidekick).toMatchObject({ model: "openai/gpt-5-mini" });
	});

	it("falls back per invalid persisted field without rejecting valid siblings", () => {
		const config = resolvePiMctxSettings({
			[PI_MCTX_SETTINGS_GROUP]: {
				enabled: false,
				memoryAutoSearchScoreThreshold: 0.96,
				historianTimeoutMs: 59_999,
			},
		});

		expect(config.enabled).toBe(false);
		expect(config.memory.auto_search.score_threshold).toBe(
			defaults.memory.auto_search.score_threshold,
		);
		expect(config.historian_timeout_ms).toBe(defaults.historian_timeout_ms);
	});

	it("registers direct operational settings for all supported controls", () => {
		const provider = createPiMctxSettingsProvider();
		const group = provider.groups[0];

		expect(group?.id).toBe(PI_MCTX_SETTINGS_GROUP);
		expect(group?.fields.map((field) => field.id)).toEqual([
			"enabled",
			"compactionEnabled",
			"systemPromptInjection",
			"temporalAwareness",
			"memoryEnabled",
			"memoryInjectionBudgetTokens",
			"memoryAutoPromote",
			"memoryRetrievalPromotionThreshold",
			"memoryAutoSearchEnabled",
			"memoryAutoSearchScoreThreshold",
			"memoryAutoSearchMinPromptChars",
			"memoryGitCommitIndexingEnabled",
			"memoryGitCommitSinceDays",
			"memoryGitCommitMaxCommits",
			"historianEnabled",
			"historianModel",
			"historianTwoPass",
			"historianTimeoutMs",
			"historyBudgetPercentage",
			"commitClusterTriggerEnabled",
			"commitClusterMinClusters",
			"sidekickModel",
		]);

		const historianModelField = group?.fields.find((field) => field.id === "historianModel");
		expect(historianModelField?.type).toBe("enum");
		expect(
			historianModelField?.enabled?.({ [PI_MCTX_SETTINGS_GROUP]: { historianEnabled: false } }),
		).toBe(false);
		expect(
			historianModelField?.enabled?.({ [PI_MCTX_SETTINGS_GROUP]: { historianEnabled: true } }),
		).toBe(true);
	});

	it("registers its provider in the ext-core runtime registry", () => {
		const pi = { events: {} } as ExtensionAPI;

		registerPiMctxSettings(pi);
		expect(getRuntimeSettingsRegistry(pi).get(PI_MCTX_SETTINGS_PROVIDER_ID)?.id).toBe(
			PI_MCTX_SETTINGS_PROVIDER_ID,
		);
	});

	it("reads extension settings without consulting legacy magic-context JSONC", () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = mkdtempSync(join(tmpdir(), "pi-mctx-settings-test-"));
		writeFileSync(
			join(agentDir, "ext_settings.json"),
			JSON.stringify({
				operational: { historianEnabled: true, historianModel: "fork/provider-model" },
			}),
		);
		writeFileSync(
			join(agentDir, "magic-context.jsonc"),
			JSON.stringify({ historian: { model: "upstream/provider-model" } }),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		resetPiMctxConfigForReload();
		try {
			const config = loadPiConfig();
			expect(config.historian?.model).toBe("fork/provider-model");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			resetPiMctxConfigForReload();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
