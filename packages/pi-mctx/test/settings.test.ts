import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHepiRuntimeSettingsRegistry, updateJsonSettingsRoot } from "@hheei/pi-ext-core";
import piMctxExtension from "../src/extension.js";
import {
	createMctxHistorianSettingsProvider,
	MCTX_HISTORIAN_SETTINGS_GROUP,
	MCTX_HISTORIAN_SETTINGS_PROVIDER_ID,
} from "../src/settings.js";

async function temporarySettings<T>(run: (path: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-mctx-settings-"));
	try {
		return await run(join(directory, "settings.json"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function parseRoot(text: string): Record<string, unknown> {
	const value: unknown = JSON.parse(text);
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected settings object");
	return Object.fromEntries(Object.entries(value));
}

test("historian provider exposes enablement and dependent model selection", async (): Promise<void> => {
	await temporarySettings(async (path) => {
		const provider = createMctxHistorianSettingsProvider({ path });
		expect(provider.id).toBe(MCTX_HISTORIAN_SETTINGS_PROVIDER_ID);
		expect(provider.moduleName).toBe("pi-mctx");
		expect(provider.onChange).toBeUndefined();
		const group = provider.groups.find(
			(candidate) => candidate.id === MCTX_HISTORIAN_SETTINGS_GROUP,
		);
		expect(group?.fields.map((field) => field.id)).toEqual(["enabled", "model"]);
		const enabled = group?.fields[0];
		const model = group?.fields[1];
		expect(enabled?.defaultValue).toBe(false);
		expect(model?.defaultValue).toBe("");
		expect(model?.enabled?.({ historian: { enabled: false, model: "provider/model" } })).toBe(
			false,
		);
		expect(model?.enabled?.({ historian: { enabled: true, model: "provider/model" } })).toBe(true);
		expect(model?.validate?.("provider/model")).toBeUndefined();
		expect(model?.validate?.("missing-provider")).toContain("provider/model");
		await expect(
			provider.storage.validate?.(
				{ historian: { enabled: true, model: "" } },
				{ sessionId: "test" },
			),
		).rejects.toThrow("provider/model");
		await expect(
			provider.storage.validate?.(
				{ historian: { enabled: false, model: "" } },
				{ sessionId: "test" },
			),
		).resolves.toBeUndefined();
	});
});

test("historian provider round-trips existing MCTX JSON without losing siblings", async (): Promise<void> => {
	await temporarySettings(async (path) => {
		await writeFile(
			path,
			JSON.stringify({
				"pi-mctx": {
					enabled: true,
					historian: { model: "old/model", retained: "keep" },
					execute_threshold_percentage: { default: 65, "old/model": 75 },
					protected_tags: 30,
					search: { primer_path: "docs/primer.md" },
				},
				external: { keep: true },
			}),
			"utf8",
		);
		const provider = createMctxHistorianSettingsProvider({ path });
		expect(await provider.storage.load({ sessionId: "test" })).toEqual({
			historian: { enabled: true, model: "old/model" },
		});
		await provider.storage.save(
			{ historian: { enabled: false, model: "new/model" } },
			{ sessionId: "test" },
		);
		expect(parseRoot(await readFile(path, "utf8"))).toEqual({
			"pi-mctx": {
				enabled: false,
				historian: { model: "new/model", retained: "keep" },
				execute_threshold_percentage: { default: 65, "old/model": 75 },
				protected_tags: 30,
				search: { primer_path: "docs/primer.md" },
			},
			external: { keep: true },
		});
	});
});

test("historian provider serializes with sibling settings writers", async (): Promise<void> => {
	await temporarySettings(async (path) => {
		const provider = createMctxHistorianSettingsProvider({ path });
		await Promise.all([
			provider.storage.save(
				{ historian: { enabled: true, model: "provider/model" } },
				{ sessionId: "test" },
			),
			updateJsonSettingsRoot(path, (root) => {
				root.external = { retained: true };
			}),
		]);
		expect(parseRoot(await readFile(path, "utf8"))).toEqual({
			"pi-mctx": { enabled: true, historian: { model: "provider/model" } },
			external: { retained: true },
		});
	});
});

test("pi-mctx registers historian settings for inactive sessions and removes it on shutdown", async (): Promise<void> => {
	const directory = await mkdtemp(join(tmpdir(), "pi-mctx-settings-lifecycle-"));
	try {
		await mkdir(join(directory, ".pi"), { recursive: true });
		await writeFile(
			join(directory, ".pi", "settings.json"),
			JSON.stringify({ "pi-mctx": { enabled: false } }),
			"utf8",
		);
		type Handler = (event: unknown, context: unknown) => void | Promise<void>;
		const handlers = new Map<string, Handler[]>();
		const pi = {
			events: {},
			on(name: string, handler: Handler): void {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			registerTool(): void {},
			registerCommand(): void {},
		};
		piMctxExtension(pi as never);
		const registry = getHepiRuntimeSettingsRegistry(pi as never);
		expect(registry.get(MCTX_HISTORIAN_SETTINGS_PROVIDER_ID)).toBeUndefined();
		const context = {
			cwd: directory,
			ui: { notify(): void {} },
		};
		for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
		expect(registry.get(MCTX_HISTORIAN_SETTINGS_PROVIDER_ID)?.moduleName).toBe("pi-mctx");
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
		expect(registry.get(MCTX_HISTORIAN_SETTINGS_PROVIDER_ID)).toBeUndefined();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
