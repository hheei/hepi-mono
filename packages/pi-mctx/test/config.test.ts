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
		{
			"pi-mctx": {
				enabled: true,
				historian: { enabled: true, model: "anthropic/claude-haiku" },
			},
		},
		{},
		loadMctxConfiguration,
	);
	expect(config.pipeline).toEqual({
		kind: "enabled",
		settings: {
			historian: { kind: "enabled", model: "anthropic/claude-haiku" },
			failClosedBlocking: DEFAULT_FAIL_CLOSED_BLOCKING,
			executeThresholdPercentage: {
				defaultValue: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
				byModel: {},
			},
			protectedTags: DEFAULT_PROTECTED_TAGS,
		},
	});
});

test("project configuration cannot enable or select the historian", async (): Promise<void> => {
	const disabled = await withSettings(
		{},
		{ "pi-mctx": { enabled: true, historian: { model: "openai/gpt-5" } } },
		loadMctxConfiguration,
	);
	expect(disabled.pipeline).toEqual({ kind: "disabled" });

	const enabled = await withSettings(
		{
			"pi-mctx": {
				enabled: true,
				historian: { enabled: true, model: "anthropic/claude-haiku" },
			},
		},
		{ "pi-mctx": { enabled: false, historian: { model: "openai/gpt-5" } } },
		loadMctxConfiguration,
	);
	expect(enabled.pipeline).toEqual({ kind: "disabled" });
});

test("exposes default merged provenance without weakening MCTX historian policy", async (): Promise<void> => {
	const config = await withSettings(
		{
			"pi-mctx": {
				enabled: true,
				historian: { enabled: true, model: "anthropic/claude-haiku" },
			},
		},
		{ "pi-mctx": { historian: { model: "openai/gpt-5" } } },
		loadMctxConfiguration,
	);
	expect(config.merged).toMatchObject({ historian: { model: "openai/gpt-5" } });
	expect(config.sourceOf(["historian", "model"])).toBe("project");
	expect(config.pipeline).toEqual({
		kind: "enabled",
		settings: {
			historian: { kind: "enabled", model: "anthropic/claude-haiku" },
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
				historian: { enabled: true, model: "anthropic/claude-haiku" },
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
			historian: { kind: "enabled", model: "anthropic/claude-haiku" },
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

test("invalid enabled historian does not disable MCTX runtime", async (): Promise<void> => {
	const config = await withSettings(
		{ "pi-mctx": { enabled: true, historian: { enabled: true, model: "claude-haiku" } } },
		{},
		loadMctxConfiguration,
	);
	expect(config.pipeline).toEqual({
		kind: "enabled",
		settings: {
			historian: { kind: "invalid", reason: "historian.model must be exact provider/model" },
			failClosedBlocking: DEFAULT_FAIL_CLOSED_BLOCKING,
			executeThresholdPercentage: {
				defaultValue: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
				byModel: {},
			},
			protectedTags: DEFAULT_PROTECTED_TAGS,
		},
	});
});

test("accepts only user-owned project-relative primer configuration", async (): Promise<void> => {
	const config = await withSettings(
		{
			"pi-mctx": {
				enabled: true,
				historian: { model: "anthropic/claude-haiku" },
				search: { primer_path: "docs/primer.md" },
			},
		},
		{ "pi-mctx": { search: { primer_path: "outside.md" } } },
		loadMctxConfiguration,
	);
	expect(config.search).toEqual({ primerPath: "docs/primer.md" });
	expect(config.warnings).toContain("Ignoring project search: primer selection is user-level only");

	const invalid = await withSettings(
		{
			"pi-mctx": {
				enabled: true,
				historian: { model: "anthropic/claude-haiku" },
				search: { primer_path: "../outside.md" },
			},
		},
		{},
		loadMctxConfiguration,
	);
	expect(invalid.search).toBeUndefined();
	expect(invalid.warnings).toContain(
		"Ignoring user search.primer_path: must be a project-relative path",
	);
});

test("accepts only user-level embedding provider configuration", async (): Promise<void> => {
	const config = await withSettings(
		{
			"pi-mctx": {
				enabled: true,
				historian: { model: "anthropic/claude-haiku" },
				embedding: { provider: "local", model: "Xenova/all-MiniLM-L6-v2" },
			},
		},
		{
			"pi-mctx": {
				embedding: { provider: "synapse", connectionFile: "/tmp/mctx.sock" },
			},
		},
		loadMctxConfiguration,
	);
	expect(config.embedding).toEqual({
		config: { provider: "local", model: "Xenova/all-MiniLM-L6-v2" },
	});
	expect(config.warnings).toContain(
		"Ignoring project embedding: provider selection is user-level only",
	);

	const invalid = await withSettings(
		{
			"pi-mctx": {
				enabled: true,
				historian: { model: "anthropic/claude-haiku" },
				embedding: "local",
			},
		},
		{},
		loadMctxConfiguration,
	);
	expect(invalid.embedding).toBeUndefined();
	expect(invalid.warnings).toContain("Ignoring user embedding: must be an object");

	const absent = await withSettings(
		{
			"pi-mctx": {
				enabled: true,
				historian: { model: "anthropic/claude-haiku" },
			},
		},
		{},
		loadMctxConfiguration,
	);
	expect(absent.embedding).toBeUndefined();
});

test("accepts only user-level Dreamer model configuration", async (): Promise<void> => {
	const config = await withSettings(
		{
			"pi-mctx": {
				dreamer: { model: "anthropic/claude-sonnet-4" },
			},
		},
		{},
		loadMctxConfiguration,
	);
	expect(config.dreamer).toEqual({ model: "anthropic/claude-sonnet-4" });

	const invalid = await withSettings(
		{ "pi-mctx": { dreamer: { model: "not-a-ref" } } },
		{},
		loadMctxConfiguration,
	);
	expect(invalid.dreamer).toBeUndefined();
	expect(invalid.warnings).toContain("Ignoring user dreamer.model: must be exact provider/model");

	const projectOnly = await withSettings(
		{},
		{ "pi-mctx": { dreamer: { model: "openai/gpt-5" } } },
		loadMctxConfiguration,
	);
	expect(projectOnly.dreamer).toBeUndefined();
	expect(projectOnly.warnings).toContain(
		"Ignoring project dreamer: model selection is user-level only",
	);

	const invalidShape = await withSettings(
		{ "pi-mctx": { dreamer: "anthropic/claude-sonnet-4" } },
		{},
		loadMctxConfiguration,
	);
	expect(invalidShape.dreamer).toBeUndefined();
	expect(invalidShape.warnings).toContain("Ignoring user dreamer: must be an object");

	const withoutModel = await withSettings(
		{ "pi-mctx": { dreamer: {} } },
		{},
		loadMctxConfiguration,
	);
	expect(withoutModel.dreamer).toEqual({});
});
