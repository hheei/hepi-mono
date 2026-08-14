import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFffRuntimeState, registerFffLifecycle } from "../../src/fff/lifecycle.js";
import {
	createBashSettingsProvider,
	createEditSettingsProvider,
	createFffSettingsProvider,
	createRtkSettingsProvider,
	DEFAULT_EDIT_MODE,
	DEFAULT_FFF_SETTINGS,
	DEFAULT_RTK_SETTINGS,
	editModeFromState,
	fffSettingsFromState,
	loadFffSettings,
	loadRtkSettings,
	readEditMode,
	rtkSettingsFromState,
} from "../../src/fff/settings.js";

describe("FFF settings", () => {
	test("uses defaults and ignores invalid persisted primitive values", () => {
		expect(fffSettingsFromState(undefined)).toEqual(DEFAULT_FFF_SETTINGS);
		expect(rtkSettingsFromState(undefined)).toEqual(DEFAULT_RTK_SETTINGS);
		expect(rtkSettingsFromState({ bash: { rtkRewrite: true } })).toEqual(DEFAULT_RTK_SETTINGS);
		expect(rtkSettingsFromState({ rtk: { rtk: true, rtkPath: " /custom/rtk " } })).toEqual({
			enabled: true,
			path: "/custom/rtk",
		});
		expect(
			fffSettingsFromState({
				fff: {
					autocomplete: false,
					grepEnhancement: true,
				},
			}),
		).toEqual({
			shellPath: DEFAULT_FFF_SETTINGS.shellPath,
			bashOutputTailKiB: 10,
			autocomplete: false,
			grepEnhancement: true,
			readEnhancement: true,
			findEnhancement: true,
		});
	});

	test("persists grouped FFF/Bash settings beside flat RTK settings", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hepi-fff-settings-"));
		try {
			const path = join(directory, "settings.json");
			const fffProvider = createFffSettingsProvider({ path });
			const bashProvider = createBashSettingsProvider({ path });
			const rtkProvider = createRtkSettingsProvider({ path });
			const context = { sessionId: "settings-test" };
			await fffProvider.storage.save({ fff: { autocomplete: false } }, context);
			await bashProvider.storage.save({ bash: { outputTailKiB: 20 } }, context);
			await rtkProvider.storage.save({ rtk: { rtk: true, rtkPath: "/custom/rtk" } }, context);
			expect(await fffProvider.storage.load(context)).toEqual({
				fff: { autocomplete: false },
			});
			expect(await bashProvider.storage.load(context)).toEqual({
				bash: { outputTailKiB: 20 },
			});
			expect(await rtkProvider.storage.load(context)).toEqual({
				rtk: { rtk: true, rtkPath: "/custom/rtk" },
			});
			expect(await loadFffSettings(fffProvider, bashProvider, context)).toEqual({
				shellPath: DEFAULT_FFF_SETTINGS.shellPath,
				bashOutputTailKiB: 20,
				autocomplete: false,
				grepEnhancement: true,
				readEnhancement: true,
				findEnhancement: true,
			});
			expect(await loadRtkSettings(rtkProvider, context)).toEqual({
				enabled: true,
				path: "/custom/rtk",
			});
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				"pi-ext-tools": {
					fff: { autocomplete: false },
					bash: { outputTailKiB: 20 },
					rtk: true,
					rtkPath: "/custom/rtk",
				},
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("loads and persists the static Edit Mode catalog setting", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hepi-edit-settings-"));
		try {
			const path = join(directory, "settings.json");
			const provider = createEditSettingsProvider({ path });
			await provider.storage.save({ edit: { mode: "native" } }, { sessionId: "settings-test" });
			expect(readEditMode(path)).toBe("native");
			expect(editModeFromState({ edit: { mode: "none" } })).toBe("none");
			expect(editModeFromState({ edit: { mode: "unsupported" } })).toBe(DEFAULT_EDIT_MODE);
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				"pi-ext-tools": { edit: { mode: "native" } },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("lifecycle loads direct RTK settings into runtime state", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hepi-rtk-lifecycle-"));
		try {
			const path = join(directory, "settings.json");
			await writeFile(
				path,
				JSON.stringify({
					"pi-ext-tools": { rtk: true, rtkPath: "/lifecycle/rtk" },
				}),
				"utf8",
			);
			const state = createFffRuntimeState();
			const handlers = new Map<
				string,
				Array<(event: unknown, context: ExtensionContext) => unknown>
			>();
			const pi = {
				events: {},
				on(event: string, handler: (event: unknown, context: ExtensionContext) => unknown): void {
					const registered = handlers.get(event) ?? [];
					registered.push(handler);
					handlers.set(event, registered);
				},
			} as unknown as ExtensionAPI;
			registerFffLifecycle(
				pi,
				state,
				createFffSettingsProvider({ path }),
				createBashSettingsProvider({ path }),
				createRtkSettingsProvider({ path }),
			);
			const context = {
				sessionManager: { getSessionId: () => "rtk-lifecycle" },
				cwd: directory,
				ui: {
					notify: (): void => undefined,
					addAutocompleteProvider: (): void => undefined,
				},
			} as unknown as ExtensionContext;
			for (const handler of handlers.get("session_start") ?? [])
				await handler({ type: "session_start" }, context);
			expect(state.getRtkSettings()).toEqual({
				enabled: true,
				path: "/lifecycle/rtk",
			});
			for (const handler of handlers.get("session_shutdown") ?? [])
				await handler({ type: "session_shutdown" }, context);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
