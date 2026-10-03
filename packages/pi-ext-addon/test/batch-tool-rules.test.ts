import { describe, expect, it, vi } from "vitest";
import {
	applyBatchToolRules,
	BATCH_TOOL_RULES_CUSTOM_FIELD,
	BATCH_TOOL_RULES_ENABLED_FIELD,
	BATCH_TOOL_RULES_GROUP,
	BATCH_TOOL_RULES_SECTION,
	BATCH_TOOL_RULES_SETTINGS_PROVIDER_ID,
	buildBatchToolPrompt,
	createBatchToolRulesSettingsProvider,
	DEFAULT_BATCH_TOOL_RULES_CONFIG,
	normalizeBatchToolRulesConfig,
} from "../src/batch-tool-rules.js";

describe("buildDefaultBatchToolPrompt & buildBatchToolPrompt", () => {
	it("generates via codemode when only codemode is available", () => {
		const prompt = buildBatchToolPrompt({ hasCodemode: true, hasEval: false });
		expect(prompt).toContain(
			"Agent turns are extremely expensive. You MUST batch and execute as many tool calls as possible in a single turn via `codemode`.",
		);
		expect(prompt).not.toContain("or `eval`");
		expect(prompt).not.toContain("SHOULD provide complete");
	});

	it("generates via codemode or eval when both are available", () => {
		const prompt = buildBatchToolPrompt({ hasCodemode: true, hasEval: true });
		expect(prompt).toContain(
			"Agent turns are extremely expensive. You MUST batch and execute as many tool calls as possible in a single turn via `codemode` or `eval`.",
		);
	});

	it("omits via clause when codemode is not available even if eval is available", () => {
		const prompt = buildBatchToolPrompt({ hasCodemode: false, hasEval: true });
		expect(prompt).toContain(
			"Agent turns are extremely expensive. You MUST batch and execute as many tool calls as possible in a single turn.\n</tool_execution_rules>",
		);
		expect(prompt).not.toContain("via");
	});

	it("omits via clause when neither is available", () => {
		const prompt = buildBatchToolPrompt({ hasCodemode: false, hasEval: false });
		expect(prompt).toContain(
			"Agent turns are extremely expensive. You MUST batch and execute as many tool calls as possible in a single turn.\n</tool_execution_rules>",
		);
		expect(prompt).not.toContain("via");
	});

	it("respects custom prompt when provided", () => {
		const custom = "<my_rules>do this</my_rules>";
		expect(buildBatchToolPrompt({ hasCodemode: true, customPrompt: custom })).toBe(custom);
	});

	it("includes parallel read/grep guidance when isGemini is true", () => {
		const prompt = buildBatchToolPrompt({ hasCodemode: true, hasEval: false, isGemini: true });
		expect(prompt).toContain(
			"Call as many `read` and `grep` operations in parallel as possible to locate information much faster.",
		);
	});
});

describe("normalizeBatchToolRulesConfig", () => {
	it("returns defaults for non-record values", () => {
		expect(normalizeBatchToolRulesConfig(undefined)).toEqual(DEFAULT_BATCH_TOOL_RULES_CONFIG);
		expect(normalizeBatchToolRulesConfig(null)).toEqual(DEFAULT_BATCH_TOOL_RULES_CONFIG);
		expect(normalizeBatchToolRulesConfig("")).toEqual(DEFAULT_BATCH_TOOL_RULES_CONFIG);
	});

	it("preserves valid configuration", () => {
		const custom = {
			[BATCH_TOOL_RULES_ENABLED_FIELD]: false,
			[BATCH_TOOL_RULES_CUSTOM_FIELD]: "custom prompt text",
		};
		expect(normalizeBatchToolRulesConfig(custom)).toEqual({
			enabled: false,
			prompt: "custom prompt text",
		});
	});
});

describe("applyBatchToolRules", () => {
	it("injects prompt section with via `codemode` when codemode is in selectedTools", () => {
		const sections: Record<string, string> = { tools: "tools content" };
		const event = {
			systemPromptOptions: {
				sections,
				selectedTools: ["read", "bash", "codemode"],
			},
		};

		applyBatchToolRules(event);

		expect(sections[BATCH_TOOL_RULES_SECTION]).toBeDefined();
		expect(sections[BATCH_TOOL_RULES_SECTION]).toContain("via `codemode`.");
		expect(sections[BATCH_TOOL_RULES_SECTION]).not.toContain("or `eval`");
	});

	it("injects prompt section with via `codemode` or `eval` when both are active", () => {
		const sections: Record<string, string> = {};
		const event = {
			systemPromptOptions: {
				sections,
				selectedTools: ["codemode", "eval"],
			},
		};

		applyBatchToolRules(event);

		expect(sections[BATCH_TOOL_RULES_SECTION]).toBeDefined();
		expect(sections[BATCH_TOOL_RULES_SECTION]).toContain("via `codemode` or `eval`.");
	});

	it("injects prompt without via when codemode is not active even if eval is active", () => {
		const sections: Record<string, string> = {};
		const event = {
			systemPromptOptions: {
				sections,
				selectedTools: ["read", "eval"],
			},
		};

		applyBatchToolRules(event);

		expect(sections[BATCH_TOOL_RULES_SECTION]).toBeDefined();
		expect(sections[BATCH_TOOL_RULES_SECTION]).not.toContain("via");
	});

	it("removes prompt section when disabled in config", () => {
		const sections: Record<string, string> = {
			[BATCH_TOOL_RULES_SECTION]: "existing",
		};
		const event = { systemPromptOptions: { sections } };

		applyBatchToolRules(event, {
			enabled: false,
			prompt: "",
		});

		expect(sections[BATCH_TOOL_RULES_SECTION]).toBeUndefined();
	});

	it("uses custom prompt from config when provided", () => {
		const sections: Record<string, string> = {};
		const event = { systemPromptOptions: { sections } };
		const customText = "<custom>rules</custom>";

		applyBatchToolRules(event, {
			enabled: true,
			prompt: customText,
		});

		expect(sections[BATCH_TOOL_RULES_SECTION]).toBe(customText);
	});

	it("handles missing sections safely without throwing", () => {
		expect(() => applyBatchToolRules({})).not.toThrow();
		expect(() => applyBatchToolRules({ systemPromptOptions: {} })).not.toThrow();
	});

	it("detects Gemini model and injects enhanced parallel read/grep rules", () => {
		const sections: Record<string, string> = {};
		const event = {
			systemPromptOptions: {
				sections,
				selectedTools: ["codemode"],
			},
		};

		applyBatchToolRules(event, DEFAULT_BATCH_TOOL_RULES_CONFIG, () => ["codemode"], {
			id: "gemini-3.8-flash",
			provider: "gm",
		});

		expect(sections[BATCH_TOOL_RULES_SECTION]).toBeDefined();
		expect(sections[BATCH_TOOL_RULES_SECTION]).toContain(
			"Call as many `read` and `grep` operations in parallel as possible to locate information much faster.",
		);
	});
});

describe("createBatchToolRulesSettingsProvider", () => {
	it("exposes settings provider definition with enabled and prompt fields", () => {
		const provider = createBatchToolRulesSettingsProvider();
		expect(provider.id).toBe(BATCH_TOOL_RULES_SETTINGS_PROVIDER_ID);
		expect(provider.groups).toHaveLength(1);

		const group = provider.groups[0]!;
		expect(group.id).toBe(BATCH_TOOL_RULES_GROUP);
		expect(group.fields).toHaveLength(2);

		const enabledField = group.fields.find((f) => f.id === BATCH_TOOL_RULES_ENABLED_FIELD);
		const promptField = group.fields.find((f) => f.id === BATCH_TOOL_RULES_CUSTOM_FIELD);
		expect(enabledField).toBeDefined();
		expect(promptField).toBeDefined();
		expect(enabledField?.type).toBe("boolean");
		expect(promptField?.type).toBe("text");
	});

	it("calls onSettingsChange on onChange", async () => {
		const onChange = vi.fn();
		const provider = createBatchToolRulesSettingsProvider({ onSettingsChange: onChange });

		await provider.onChange?.(
			{
				groupId: BATCH_TOOL_RULES_GROUP,
				fieldId: BATCH_TOOL_RULES_ENABLED_FIELD,
				value: false,
				state: {
					[BATCH_TOOL_RULES_GROUP]: {
						[BATCH_TOOL_RULES_ENABLED_FIELD]: false,
						[BATCH_TOOL_RULES_CUSTOM_FIELD]: "saved prompt",
					},
				},
			},
			{ cwd: "/test", sessionId: "test-session" },
		);

		expect(onChange).toHaveBeenCalledWith({
			enabled: false,
			prompt: "saved prompt",
		});
	});
});
