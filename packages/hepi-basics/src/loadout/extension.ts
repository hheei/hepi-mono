import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	disableHePiTool,
	getHePiRuntimeLoadoutGroupRegistry,
	getHePiRuntimeModuleRegistry,
	getToolActivationCoordinator,
	HePiLifecycleController,
	hePiLoadoutKey,
	registerHePiLifecycle,
	registerHePiModule,
	setHePiDisabledSkillKeys,
} from "../core/index.js";
import {
	createLoadoutController,
	type LoadoutController,
	type LoadoutRuntimeHandlers,
} from "./controller.js";
import { createLoadoutModule } from "./index.js";
import { createLoadoutInventoryProvider } from "./inventory.js";
import { filterLoadoutDisabledSkillsFromPrompt } from "./skill-prompt-filter.js";
import {
	createLoadoutStorage,
	defaultLoadoutStoragePaths,
	initialLoadoutScope,
} from "./storage.js";

export default function piLoadoutExtension(pi: ExtensionAPI): void {
	const coordinator = getToolActivationCoordinator(pi);
	const moduleRegistry = getHePiRuntimeModuleRegistry(pi);
	const loadoutGroupRegistry = getHePiRuntimeLoadoutGroupRegistry(pi);
	let disabledSkillKeys: ReadonlySet<string> = new Set();
	let startupController: LoadoutController | undefined;
	const runtimeHandlers: LoadoutRuntimeHandlers = {
		tool: async (items, signal) => {
			signal?.throwIfAborted();
			const activeNames = [
				...new Set(
					items.filter((item) => item.effectiveStatus === "active").map((item) => item.name),
				),
			];
			coordinator.setLoadoutBaseline(activeNames);
			for (const item of items) {
				signal?.throwIfAborted();
				if (item.effectiveStatus === "disabled") await disableHePiTool(pi, item.name);
			}
			signal?.throwIfAborted();
		},
		skill: async (items, signal) => {
			signal?.throwIfAborted();
			disabledSkillKeys = new Set(
				items
					.filter((item) => item.effectiveStatus === "disabled")
					.map((item) => hePiLoadoutKey("skill", item.name)),
			);
			signal?.throwIfAborted();
			setHePiDisabledSkillKeys(pi, disabledSkillKeys);
		},
	};

	pi.on("before_agent_start", (event) => {
		const filtered = filterLoadoutDisabledSkillsFromPrompt(
			event.systemPrompt,
			event.systemPromptOptions,
			disabledSkillKeys,
		);
		if (filtered === undefined) return;
		event.systemPromptOptions.skills = filtered.skills;
		if (filtered.systemPrompt !== event.systemPrompt)
			return { systemPrompt: filtered.systemPrompt };
	});
	const loadoutModule = createLoadoutModule(pi, runtimeHandlers, () => loadoutGroupRegistry.list());
	registerHePiLifecycle(
		pi,
		new HePiLifecycleController({
			onStart: async (runtime) => {
				const unregisterModule = registerHePiModule(loadoutModule, moduleRegistry);
				runtime.registry.registerLifecycle({
					id: "loadout-module",
					cleanup: unregisterModule,
				});
				const defaults = defaultLoadoutStoragePaths();
				startupController = createLoadoutController({
					storage: createLoadoutStorage({
						globalPath: defaults.globalPath,
						projectPath: join(runtime.ctx.cwd, ".pi", "setting.json"),
					}),
					scope: await initialLoadoutScope(runtime.ctx.cwd),
					inventory: createLoadoutInventoryProvider(pi, () => loadoutGroupRegistry.list()),
					runtime: runtimeHandlers,
				});
				await startupController.load().catch((error) => {
					runtime.ctx.ui.notify(
						`Unable to load HEPI Loadout: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				});
				runtime.registry.registerLifecycle({
					id: "loadout",
					cleanup: async () => {
						try {
							await startupController?.close();
						} finally {
							startupController = undefined;
							disabledSkillKeys = new Set();
							setHePiDisabledSkillKeys(pi, disabledSkillKeys);
						}
					},
				});
			},
		}),
	);
}
