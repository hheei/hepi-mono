import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	disableHepiTool,
	getHepiRuntimeLoadoutGroupRegistry,
	getHepiRuntimeModuleRegistry,
	getToolActivationCoordinator,
	HepiLifecycleController,
	hepiLoadoutKey,
	isHepiSubagentSession,
	registerHepiLifecycle,
	registerHepiModule,
	setHepiDisabledSkillKeys,
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
	const moduleRegistry = getHepiRuntimeModuleRegistry(pi);
	const loadoutGroupRegistry = getHepiRuntimeLoadoutGroupRegistry(pi);
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
				if (item.effectiveStatus === "disabled") await disableHepiTool(pi, item.name);
			}
			signal?.throwIfAborted();
		},
		skill: async (items, signal) => {
			signal?.throwIfAborted();
			disabledSkillKeys = new Set(
				items
					.filter((item) => item.effectiveStatus === "disabled")
					.map((item) => hepiLoadoutKey("skill", item.name)),
			);
			signal?.throwIfAborted();
			setHepiDisabledSkillKeys(pi, disabledSkillKeys);
		},
	};

	pi.on("before_agent_start", (event) => {
		const filtered = filterLoadoutDisabledSkillsFromPrompt(
			event.systemPrompt,
			event.systemPromptOptions,
			disabledSkillKeys,
		);
		if (filtered === undefined) return;
		if (filtered.systemPrompt !== event.systemPrompt)
			return { systemPrompt: filtered.systemPrompt };
	});
	const loadoutModule = createLoadoutModule(pi, runtimeHandlers, () => loadoutGroupRegistry.list());
	registerHepiLifecycle(
		pi,
		new HepiLifecycleController({
			onStart: async (runtime) => {
				if (isHepiSubagentSession(pi)) return;
				const unregisterModule = registerHepiModule(loadoutModule, moduleRegistry);
				runtime.registry.registerLifecycle({
					id: "loadout-module",
					cleanup: unregisterModule,
				});
				const defaults = defaultLoadoutStoragePaths(runtime.ctx.cwd);
				startupController = createLoadoutController({
					storage: createLoadoutStorage(defaults),
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
							setHepiDisabledSkillKeys(pi, disabledSkillKeys);
						}
					},
				});
			},
		}),
		"pi-basics-loadout",
	);
}
