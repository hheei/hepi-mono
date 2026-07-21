import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { HePiModule, HePiModuleRegistry } from "./api/modules.js";
import { listHePiSettings } from "./api/settings.js";
import { registerHePiCommand } from "./command/hepi-command.js";
import { createStatusbarFeature } from "./contributions/statusbar/index.js";
import { createAskFeature } from "./modules/ask/index.js";
import {
	autoTitleModelOptions,
	createAutoTitleCoordinator,
	createAutoTitleSettingsProvider,
	parseModelRef,
	provisionAutoTitleAgent,
	requireAutoTitleSubagents,
} from "./modules/auto-title/index.js";
import { createGoalFeature } from "./modules/goal/feature.js";
import { createLoadoutView } from "./modules/loadout/component.js";
import { createLoadoutController, type LoadoutController } from "./modules/loadout/controller.js";
import { createLoadoutInventoryProvider } from "./modules/loadout/inventory.js";
import { createLoadoutStorage, defaultLoadoutStoragePaths } from "./modules/loadout/storage.js";
import { createPlanFeature } from "./modules/plan/index.js";
import { createSettingsComponent } from "./modules/setting/component.js";
import { SettingsController } from "./modules/setting/controller.js";
import { createShellModule } from "./modules/shell/index.js";
import { createTodoFeature } from "./modules/todo/index.js";
import {
	createTraditionalToSimplifiedFeature,
	createTraditionalToSimplifiedSettingsProvider,
} from "./modules/traditional-to-simplified/index.js";
import type { HePiRuntimeContext } from "./runtime/context.js";
import { HePiLifecycleController, registerHePiLifecycle } from "./runtime/lifecycle.js";
import { createToolActivationCoordinator } from "./runtime/tool-activation.js";

const createAutoTitleProvider = (
	runtime: HePiRuntimeContext,
	onPersisted: (model: string | undefined) => void,
) =>
	createAutoTitleSettingsProvider({
		path: join(runtime.ctx.cwd, ".pi", "settings.json"),
		modelOptions: autoTitleModelOptions(runtime.ctx.modelRegistry?.getAvailable?.() ?? []),
		validate: async (value) => {
			const { provider, model: modelId } = parseModelRef(value);
			const model = runtime.ctx.modelRegistry.find(provider, modelId);
			if (!model || !runtime.ctx.modelRegistry.hasConfiguredAuth(model))
				throw new Error(`Unavailable title model: ${value}`);
			const auth = await runtime.ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);
			await requireAutoTitleSubagents(runtime.pi);
		},
		prepareEnable: () => provisionAutoTitleAgent(runtime.ctx.cwd),
		onPersisted,
	});

const moduleRegistries = new Map<HePiLifecycleController, HePiModuleRegistry>();

function activeModuleRegistry(): HePiModuleRegistry {
	const active = [...moduleRegistries.entries()].filter(([lifecycle]) => lifecycle.current);
	if (active.length === 0) throw new Error("HEPI module registration requires an active session");
	if (active.length > 1)
		throw new Error("HEPI module registration is ambiguous across active sessions");
	return active[0]![1];
}

export function registerHePiModule(module: HePiModule, registry?: HePiModuleRegistry): void {
	(registry ?? activeModuleRegistry()).register(module);
}

export default function piBasicsExtension(pi: ExtensionAPI): void {
	let settingsController: SettingsController | undefined;
	let autoTitleCoordinator: { dispose: () => void } | undefined;
	let loadoutController: LoadoutController | undefined;
	const coordinator = createToolActivationCoordinator(pi);
	const statusbar = createStatusbarFeature(pi);
	const goal = createGoalFeature(pi, coordinator);
	const ask = createAskFeature(pi, coordinator);
	const todo = createTodoFeature(pi);
	const plan = createPlanFeature(pi);
	const traditionalToSimplified = createTraditionalToSimplifiedFeature();
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			if (typeof runtime.pi.getActiveTools === "function") {
				coordinator.setLoadoutBaseline(runtime.pi.getActiveTools());
			}
			await goal.start(runtime);
			const goalSessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({
				id: "goal",
				cleanup: () => goal.dispose(goalSessionId),
			});
			statusbar.start(runtime);
			const statusbarSessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({
				id: "statusbar",
				cleanup: () => statusbar.dispose(statusbarSessionId),
			});
			await todo.start(runtime);
			const todoSessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({
				id: "todo",
				cleanup: () => todo.dispose(todoSessionId),
			});
			traditionalToSimplified.start(runtime);
			const traditionalToSimplifiedSessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({
				id: "traditional-to-simplified",
				cleanup: () => traditionalToSimplified.dispose(traditionalToSimplifiedSessionId),
			});
			const availableTitleModels = runtime.ctx.modelRegistry?.getAvailable?.() ?? [];
			const defaultTitleModel = availableTitleModels[0];
			const traditionalToSimplifiedProvider = createTraditionalToSimplifiedSettingsProvider({
				onPersisted: (enabled) => traditionalToSimplified.setEnabled(enabled),
			});
			const autoTitleProvider = createAutoTitleProvider(runtime, (model) => {
				autoTitleCoordinator?.dispose();
				const selected =
					model ||
					(defaultTitleModel ? `${defaultTitleModel.provider}/${defaultTitleModel.id}` : undefined);
				autoTitleCoordinator = selected ? createAutoTitleCoordinator(runtime, selected) : undefined;
			});
			void Promise.resolve(
				autoTitleProvider.storage.load({
					sessionId: runtime.ctx.sessionManager.getSessionId(),
					cwd: runtime.ctx.cwd,
				}),
			)
				.then((state) =>
					autoTitleProvider.onLoad?.(state ?? {}, {
						sessionId: runtime.ctx.sessionManager.getSessionId(),
						cwd: runtime.ctx.cwd,
					}),
				)
				.catch((error: unknown) =>
					runtime.ctx.ui.notify(
						`Unable to load HEPI automatic title settings: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					),
				);
			const providers = () => [
				traditionalToSimplifiedProvider,
				autoTitleProvider,
				...listHePiSettings().filter((provider) => provider.id !== autoTitleProvider.id),
			];
			const defaults = defaultLoadoutStoragePaths();
			const storage = createLoadoutStorage({
				globalPath: defaults.globalPath,
				projectPath: join(runtime.ctx.cwd, ".pi", "setting.json"),
			});
			loadoutController = createLoadoutController({
				storage,
				inventory: createLoadoutInventoryProvider(pi),
				runtime: {
					tool: async (items) => {
						const names = [
							...new Set(
								items.filter((item) => item.effectiveStatus === "active").map((item) => item.name),
							),
						];
						const disablingGoal = coordinator.isConfigured("goal") && !names.includes("goal");
						coordinator.setLoadoutBaseline(names);
						if (disablingGoal) await goal.disableFromLoadout();
					},
				},
			});
			await loadoutController.load().catch((error) => {
				runtime.ctx.ui.notify(
					`Unable to load HEPI Loadout: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			});
			await ask.start(runtime);
			const askSessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({
				id: "ask",
				cleanup: () => ask.dispose(askSessionId),
			});
			plan.start(runtime);
			const planSessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({
				id: "plan",
				cleanup: () => plan.dispose(planSessionId),
			});
			const shell = createShellModule({
				settings: ({ context, host, theme }) => {
					const next = new SettingsController({ context, providers: providers() });
					settingsController = next;
					void next.load().catch((error) => {
						runtime.ctx.ui.notify(
							`Unable to load HEPI Settings: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					});
					return createSettingsComponent({
						controller: next,
						host,
						theme,
						close: () => undefined,
						showTabs: false,
					});
				},
				loadout: ({ host, theme, height }) => {
					if (!loadoutController) throw new Error("HEPI Loadout controller is unavailable");
					return createLoadoutView({ controller: loadoutController, host, theme, height });
				},
			});
			runtime.registry.registerModule(shell);
			runtime.registry.registerLifecycle({
				id: "shell",
				cleanup: async () => {
					autoTitleCoordinator?.dispose();
					autoTitleCoordinator = undefined;
					await settingsController?.close();
					await loadoutController?.close();
					settingsController = undefined;
					loadoutController = undefined;
				},
			});
		},
	});
	pi.on("before_agent_start", async (event) => {
		const controller = loadoutController;
		if (!controller) return;
		const skills = event.systemPromptOptions.skills ?? [];
		if (skills.length === 0) return;
		const enabled = new Set(
			controller.state.resolved
				.filter((item) => item.kind === "skill" && item.effectiveStatus === "active")
				.map((item) => item.name),
		);
		const filtered = skills.filter((skill) => enabled.has(skill.name));
		if (filtered.length === skills.length) return;
		const block =
			/\n?The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
		const replacement = formatSkillsForPrompt(filtered);
		return {
			systemPrompt: event.systemPrompt.replace(block, replacement ? `\n${replacement}` : ""),
		};
	});
	const commandRegistry: HePiModuleRegistry = {
		register(module) {
			const runtime = lifecycle.current;
			if (!runtime) throw new Error("HEPI module registration requires an active session");
			runtime.registry.registerModule(module);
		},
		list: () => lifecycle.current?.registry.listModules<HePiModule>() ?? [],
		get: (id) => lifecycle.current?.registry.getModule<HePiModule>(id),
	};
	moduleRegistries.set(lifecycle, commandRegistry);
	registerHePiCommand(pi, commandRegistry);
	registerHePiLifecycle(pi, lifecycle);
}
export * from "./api/index.js";
export * from "./modules/goal/index.js";
export {
	createLoadoutController,
	type LoadoutController,
	type LoadoutControllerOptions,
	type LoadoutRuntimeHandler,
	type LoadoutRuntimeHandlers,
} from "./modules/loadout/controller.js";
export { createLoadoutModule } from "./modules/loadout/index.js";
export type {
	LoadoutCommandInfo,
	LoadoutInventory,
	LoadoutInventoryProvider,
	LoadoutInventorySource,
	LoadoutInventoryValue,
} from "./modules/loadout/inventory.js";
export {
	createLoadoutInventory,
	createLoadoutInventoryProvider,
	createMcpPlaceholder,
	mergeLoadoutInventory,
} from "./modules/loadout/inventory.js";
export * from "./modules/loadout/model.js";
export type {
	LoadoutStorage,
	LoadoutStoragePaths,
	LoadoutStoredState,
} from "./modules/loadout/storage.js";
export { createLoadoutStorage, defaultLoadoutStoragePaths } from "./modules/loadout/storage.js";
export * from "./modules/plan/index.js";
export { createSettingsModule } from "./modules/setting/index.js";
export { createHePiRuntimeContext, type HePiRuntimeContext } from "./runtime/context.js";
export { HePiLifecycleController, registerHePiLifecycle } from "./runtime/lifecycle.js";
export type {
	HePiCleanupFailure,
	HePiIdentified,
	HePiLifecycleRegistration,
	HePiRegistrationKind,
} from "./runtime/registry.js";
export { HePiRegistry } from "./runtime/registry.js";
export {
	createToolActivationCoordinator,
	type ToolActivationCoordinator,
} from "./runtime/tool-activation.js";
