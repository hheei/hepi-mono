import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	disableHePiTool,
	getToolActivationCoordinator,
	HePiLifecycleController,
	hePiLoadoutKey,
	registerHePiLifecycle,
	registerHePiModule,
	setHePiDisabledSkillKeys,
} from "@hheei/pi-basics";
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
	let disabledSkillKeys: ReadonlySet<string> = new Set();
	let startupController: LoadoutController | undefined;
	const runtimeHandlers: LoadoutRuntimeHandlers = {
		tool: async (items) => {
			const activeNames = [
				...new Set(
					items.filter((item) => item.effectiveStatus === "active").map((item) => item.name),
				),
			];
			coordinator.setLoadoutBaseline(activeNames);
			for (const item of items)
				if (item.effectiveStatus === "disabled") await disableHePiTool(pi, item.name);
		},
		skill: async (items) => {
			disabledSkillKeys = new Set(
				items
					.filter((item) => item.effectiveStatus === "disabled")
					.map((item) => hePiLoadoutKey("skill", item.name, item.origin)),
			);
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
	const loadoutModule = createLoadoutModule(pi, runtimeHandlers);
	registerHePiLifecycle(
		pi,
		new HePiLifecycleController({
			onStart: async (runtime) => {
				const unregisterModule = registerHePiModule(loadoutModule);
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
					inventory: createLoadoutInventoryProvider(pi),
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
