import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SETTING_DESCRIPTION_MIN_LENGTH = 20;

import { describe, expect, it, vi } from "vitest";
import {
	createMemorySettingsProvider,
	createMemorySettingsStorage,
	ensureModelOption,
	HINDSIGHT_API_URL_FIELD,
	HINDSIGHT_AUTO_RECALL_FIELD,
	HINDSIGHT_BANK_ID_FIELD,
	HINDSIGHT_ENABLED_FIELD,
	HINDSIGHT_RETAIN_SESSIONS_FIELD,
	MEMORY_DEBUG_LOG_FIELD,
	MEMORY_MODEL_FIELD,
	MEMORY_MODEL_THINKING_FIELD,
	MEMORY_NOTIFICATIONS_FIELD,
	MEMORY_PASSIVE_FIELD,
	MEMORY_SETTINGS_GROUP,
	MEMORY_SETTINGS_PROVIDER_ID,
	parseModelRef,
} from "../src/settings.js";

describe("memory settings", () => {
	it("satisfies the settings description length invariant on all fields and tab cycles", () => {
		const provider = createMemorySettingsProvider();
		expect(provider.id).toBe(MEMORY_SETTINGS_PROVIDER_ID);
		expect(provider.groups).toHaveLength(1);
		const group = provider.groups[0]!;
		expect(group.id).toBe(MEMORY_SETTINGS_GROUP);

		for (const field of group.fields) {
			expect(
				field.description.trim().length,
				`field ${field.id} description must be at least ${SETTING_DESCRIPTION_MIN_LENGTH}`,
			).toBeGreaterThanOrEqual(SETTING_DESCRIPTION_MIN_LENGTH);

			if (field.tabCycle !== undefined) {
				expect(
					field.tabCycle.description.trim().length,
					`cycle ${field.tabCycle.fieldId} description must be at least ${SETTING_DESCRIPTION_MIN_LENGTH}`,
				).toBeGreaterThanOrEqual(SETTING_DESCRIPTION_MIN_LENGTH);
			}
		}
	});

	it("parses model references correctly and rejects malformed values", () => {
		expect(parseModelRef("gm/gemini-3.8-flash")).toEqual({
			provider: "gm",
			model: "gemini-3.8-flash",
		});
		expect(parseModelRef("openrouter/anthropic/claude-3.7-sonnet")).toEqual({
			provider: "openrouter",
			model: "anthropic/claude-3.7-sonnet",
		});
		expect(() => parseModelRef("invalid")).toThrow("Model must be in provider/id format");
		expect(() => parseModelRef("/only-model")).toThrow("Model must be in provider/id format");
	});

	it("ensures configured model option is present", () => {
		const base = [{ value: "", label: "Not set" }];
		const next = ensureModelOption(base, "gm/gemini-3.8-flash");
		expect(next).toHaveLength(2);
		expect(next[1]?.value).toBe("gm/gemini-3.8-flash");

		// Deduplication
		const again = ensureModelOption(next, "gm/gemini-3.8-flash");
		expect(again).toHaveLength(2);
	});

	it("loads and saves settings round-trip while preserving sibling keys", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-ext-memory-settings-"));
		try {
			const settingsPath = join(dir, "ext_settings.json");
			const initialJson = {
				otherExtension: { foo: "bar" },
				"pi-ext-memory": {
					observeAfterTokens: 15_000,
					compactAfterTokens: 90_000,
					model: {
						provider: "gm",
						id: "gemini-3.8-flash",
						thinking: "low",
					},
					hindsight: {
						enabled: true,
						apiUrl: "https://hindsight.hheei.cc",
						bankId: "my-bank",
						autoRecall: false,
						retainSessions: true,
					},
					passive: true,
					showWorkerNotifications: false,
					debugLog: true,
				},
			};
			await writeFile(settingsPath, JSON.stringify(initialJson, null, 2), "utf8");

			const onSaved = vi.fn();
			const storage = createMemorySettingsStorage({
				path: settingsPath,
				onSaved,
			});

			const loaded = await storage.load({ cwd: dir, sessionId: "test-session" });
			expect(loaded).toBeDefined();
			const values = loaded![MEMORY_SETTINGS_GROUP]!;
			expect(values[MEMORY_MODEL_FIELD]).toBe("gm/gemini-3.8-flash");
			expect(values[MEMORY_MODEL_THINKING_FIELD]).toBe("low");
			expect(values[MEMORY_PASSIVE_FIELD]).toBe(true);
			expect(values[MEMORY_NOTIFICATIONS_FIELD]).toBe(false);
			expect(values[MEMORY_DEBUG_LOG_FIELD]).toBe(true);
			expect(values[HINDSIGHT_ENABLED_FIELD]).toBe(true);
			expect(values[HINDSIGHT_API_URL_FIELD]).toBe("https://hindsight.hheei.cc");
			expect(values[HINDSIGHT_BANK_ID_FIELD]).toBe("my-bank");
			expect(values[HINDSIGHT_AUTO_RECALL_FIELD]).toBe(false);
			expect(values[HINDSIGHT_RETAIN_SESSIONS_FIELD]).toBe(true);

			// Mutate values and save
			const updatedState = {
				[MEMORY_SETTINGS_GROUP]: {
					...values,
					[MEMORY_MODEL_FIELD]: "openrouter/anthropic/claude-3.7-sonnet",
					[MEMORY_MODEL_THINKING_FIELD]: "high",
					[HINDSIGHT_BANK_ID_FIELD]: "", // clearing bankId
				},
			};

			await storage.save(updatedState, { cwd: dir, sessionId: "test-session" });
			expect(onSaved).toHaveBeenCalled();

			const savedJson = JSON.parse(await readFile(settingsPath, "utf8"));
			// Sibling group preserved
			expect(savedJson.otherExtension).toEqual({ foo: "bar" });
			// Non-UI keys preserved
			expect(savedJson["pi-ext-memory"].observeAfterTokens).toBe(15_000);
			expect(savedJson["pi-ext-memory"].compactAfterTokens).toBe(90_000);
			// Model updated
			expect(savedJson["pi-ext-memory"].model).toEqual({
				provider: "openrouter",
				id: "anthropic/claude-3.7-sonnet",
				thinking: "high",
			});
			// Hindsight updated, bankId removed when blank
			expect(savedJson["pi-ext-memory"].hindsight.enabled).toBe(true);
			expect(savedJson["pi-ext-memory"].hindsight.apiUrl).toBe("https://hindsight.hheei.cc");
			expect(savedJson["pi-ext-memory"].hindsight.bankId).toBeUndefined();

			// Test clearing model
			const noModelState = {
				[MEMORY_SETTINGS_GROUP]: {
					...updatedState[MEMORY_SETTINGS_GROUP],
					[MEMORY_MODEL_FIELD]: "",
				},
			};
			await storage.save(noModelState, { cwd: dir, sessionId: "test-session" });
			const noModelJson = JSON.parse(await readFile(settingsPath, "utf8"));
			expect(noModelJson["pi-ext-memory"].model).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
