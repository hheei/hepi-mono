import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
	DEFAULT_FAIL_CLOSED_BLOCKING,
	DEFAULT_PROTECTED_TAGS,
	loadMctxConfiguration,
	type MctxSettingsPaths,
} from "../src/config.js";

async function withSettings<T>(
	global: unknown,
	project: unknown,
	run: (paths: MctxSettingsPaths) => Promise<T>,
): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-mctx-config-"));
	const paths = {
		globalPath: join(directory, "global.json"),
		projectPath: join(directory, "project.json"),
	};
	try {
		await writeFile(paths.globalPath, JSON.stringify(global), "utf8");
		await writeFile(paths.projectPath, JSON.stringify(project), "utf8");
		return await run(paths);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("disabled configuration leaves pipeline inactive", async (): Promise<void> => {
	const config = await withSettings({}, {}, loadMctxConfiguration);
	expect(config.pipeline).toEqual({ kind: "disabled" });
});

test("enabled user configuration resolves pipeline defaults", async (): Promise<void> => {
	const config = await withSettings(
		{ "pi-mctx": { enabled: true, historian: { model: "anthropic/claude-haiku" } } },
		{},
		loadMctxConfiguration,
	);
	expect(config.pipeline).toEqual({
		kind: "enabled",
		settings: {
			historianModel: "anthropic/claude-haiku",
			failClosedBlocking: DEFAULT_FAIL_CLOSED_BLOCKING,
			executeThresholdPercentage: {
				defaultValue: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
				byModel: {},
			},
			protectedTags: DEFAULT_PROTECTED_TAGS,
		},
	});
});

test("accepts only user-level embedding provider configuration", async (): Promise<void> => {
	const config = await withSettings(
		{
			"pi-mctx": {
				enabled: true,
				historian: { model: "anthropic/claude-haiku" },
				embedding: { provider: "local", model: "Xenova/test" },
			},
		},
		{ "pi-mctx": { embedding: { provider: "synapse" } } },
		loadMctxConfiguration,
	);
	expect(config.embedding).toEqual({ provider: "local", model: "Xenova/test" });
	expect(config.warnings).toContain(
		"Ignoring project embedding: only user config may select embedding providers",
	);
});

test("project configuration cannot enable or select the historian", async (): Promise<void> => {
	const disabled = await withSettings(
		{},
		{ "pi-mctx": { enabled: true, historian: { model: "openai/gpt-5" } } },
		loadMctxConfiguration,
	);
	expect(disabled.pipeline).toEqual({ kind: "disabled" });

	const enabled = await withSettings(
		{ "pi-mctx": { enabled: true, historian: { model: "anthropic/claude-haiku" } } },
		{ "pi-mctx": { enabled: false, historian: { model: "openai/gpt-5" } } },
		loadMctxConfiguration,
	);
	expect(enabled.pipeline).toEqual({ kind: "disabled" });
});

test("exposes default merged provenance without weakening MCTX historian policy", async (): Promise<void> => {
	const config = await withSettings(
		{ "pi-mctx": { enabled: true, historian: { model: "anthropic/claude-haiku" } } },
		{ "pi-mctx": { historian: { model: "openai/gpt-5" } } },
		loadMctxConfiguration,
	);
	expect(config.merged).toMatchObject({ historian: { model: "openai/gpt-5" } });
	expect(config.sourceOf(["historian", "model"])).toBe("project");
	expect(config.pipeline).toEqual({
		kind: "enabled",
		settings: {
			historianModel: "anthropic/claude-haiku",
			failClosedBlocking: true,
			executeThresholdPercentage: { defaultValue: 65, byModel: {} },
			protectedTags: DEFAULT_PROTECTED_TAGS,
		},
	});
});

test("project configuration can only raise configured trigger thresholds", async (): Promise<void> => {
	const config = await withSettings(
		{
			"pi-mctx": {
				enabled: true,
				historian: { model: "anthropic/claude-haiku" },
				execute_threshold_percentage: { default: 65, "anthropic/claude-haiku": 70 },
				execute_threshold_tokens: { default: 10_000 },
			},
		},
		{
			"pi-mctx": {
				execute_threshold_percentage: { default: 60, "anthropic/claude-haiku": 75 },
				execute_threshold_tokens: { default: 12_000, "anthropic/claude-haiku": 8_000 },
			},
		},
		loadMctxConfiguration,
	);
	expect(config.pipeline).toEqual({
		kind: "enabled",
		settings: {
			historianModel: "anthropic/claude-haiku",
			failClosedBlocking: true,
			executeThresholdPercentage: {
				defaultValue: 65,
				byModel: { "anthropic/claude-haiku": 75 },
			},
			executeThresholdTokens: {
				defaultValue: 12_000,
				byModel: {},
			},
			protectedTags: DEFAULT_PROTECTED_TAGS,
		},
	});
});

test("enabled configuration requires a valid historian model", async (): Promise<void> => {
	const config = await withSettings(
		{ "pi-mctx": { enabled: true, historian: { model: "claude-haiku" } } },
		{},
		loadMctxConfiguration,
	);
	expect(config.pipeline).toEqual({
		kind: "invalid",
		reason: "historian.model must be exact provider/model",
	});
});
