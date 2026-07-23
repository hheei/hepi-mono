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
} from "./modules/auto-title/index.js";
import {
	createDollarSkillFeature,
	createDollarSkillSettingsProvider,
	registerDollarSkillInputTransform,
} from "./modules/dollar-skill/index.js";
import { createGoalFeature } from "./modules/goal/feature.js";
import { createLoadoutView } from "./modules/loadout/component.js";
import { createLoadoutController, type LoadoutController } from "./modules/loadout/controller.js";
import { createLoadoutInventoryProvider } from "./modules/loadout/inventory.js";
import { loadoutKey } from "./modules/loadout/model.js";
import { filterLoadoutDisabledSkillsFromPrompt } from "./modules/loadout/skill-prompt-filter.js";
import { createLoadoutStorage, defaultLoadoutStoragePaths } from "./modules/loadout/storage.js";
import { createPlanFeature } from "./modules/plan/index.js";
import { registerRtkCommand } from "./modules/rtk/command.js";
import { createRtkFeature } from "./modules/rtk/feature.js";
import { createRtkSettingsProvider } from "./modules/rtk/settings.js";
import { combineSettingsProviders } from "./modules/setting/combined.js";
import { createSettingsComponent } from "./modules/setting/component.js";
import { SettingsController } from "./modules/setting/controller.js";
import { createShellModule } from "./modules/shell/index.js";
import { createSshfsFeature } from "./modules/sshfs/index.js";
import { createTodoFeature } from "./modules/todo/index.js";
import {
	createTraditionalToSimplifiedFeature,
	createTraditionalToSimplifiedSettingsProvider,
} from "./modules/traditional-to-simplified/index.js";
import {
	createApplyPatchGuardSettingsProvider,
	registerApplyPatchGuard,
} from "./runtime/apply-patch-guard.js";
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
		},
		onPersisted,
	});

const moduleRegistries = new Map<HePiLifecycleController, HePiModuleRegistry>();

function activeModuleRegistry(): HePiModuleRegistry {
	const active = [...moduleRegistries.entries()].filter(([lifecycle]) => lifecycle.current);
	if (active.length === 0) throw new Error("HEPI module registration requires an active session");
	if (active.length > 1)
		throw new Error("HEPI module registration is ambiguous across active sessions");
	const entry = active[0];
	if (entry === undefined) throw new Error("HEPI module registration requires an active session");
	return entry[1];
}

export function registerHePiModule(module: HePiModule, registry?: HePiModuleRegistry): void {
	(registry ?? activeModuleRegistry()).register(module);
}

export default function piBasicsExtension(pi: ExtensionAPI): void {
	const applyPatchGuard = registerApplyPatchGuard(pi);
	const applyPatchGuardProvider = createApplyPatchGuardSettingsProvider(applyPatchGuard);
	let settingsController: SettingsController | undefined;
	let autoTitleCoordinator:
		| { trigger: (force?: boolean) => void; setModel: (model: string) => void; dispose: () => void }
		| undefined;
	let loadoutController: LoadoutController | undefined;
	let disabledDollarSkillKeys: ReadonlySet<string> = new Set();
	const coordinator = createToolActivationCoordinator(pi);
	const rtk = createRtkFeature();
	registerRtkCommand(pi, rtk);
	const statusbar = createStatusbarFeature(pi);
	const goal = createGoalFeature(pi, coordinator);
	const ask = createAskFeature(pi, coordinator);
	const todo = createTodoFeature(pi);
	const sshfs = createSshfsFeature(pi);
	const plan = createPlanFeature(pi);
	const dollarSkill = createDollarSkillFeature(pi, (command) => {
		const source = command.sourceInfo?.source;
		if (source === undefined) return true;
		const name = command.name.startsWith("skill:")
			? command.name.slice("skill:".length)
			: command.name;
		return !disabledDollarSkillKeys.has(loadoutKey("skill", name, source));
	});
	const dollarSkillProvider = createDollarSkillSettingsProvider(dollarSkill);
	registerDollarSkillInputTransform(pi, dollarSkill);
	pi.on("before_agent_start", (event) => {
		const filtered = filterLoadoutDisabledSkillsFromPrompt(
			event.systemPrompt,
			event.systemPromptOptions,
			disabledDollarSkillKeys,
		);
		if (filtered === undefined) return;
		event.systemPromptOptions.skills = filtered.skills;
		if (filtered.systemPrompt !== event.systemPrompt) {
			return { systemPrompt: filtered.systemPrompt };
		}
	});
	const traditionalToSimplified = createTraditionalToSimplifiedFeature();
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			coordinator.reset();
			disabledDollarSkillKeys = new Set();
			runtime.registry.registerLifecycle({
				id: "tool-activation",
				cleanup: () => coordinator.reset(),
			});
			runtime.registry.registerLifecycle({ id: "sshfs", cleanup: () => sshfs.dispose() });
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
			try {
				const state = await dollarSkillProvider.storage.load({
					sessionId: runtime.ctx.sessionManager.getSessionId(),
					cwd: runtime.ctx.cwd,
				});
				await dollarSkillProvider.onLoad?.(state ?? {}, {
					sessionId: runtime.ctx.sessionManager.getSessionId(),
					cwd: runtime.ctx.cwd,
				});
			} catch (error) {
				runtime.ctx.ui.notify(
					`Unable to load dollar skill settings: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			dollarSkill.start(runtime);
			const dollarSkillSessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({
				id: "dollar-skill",
				cleanup: () => dollarSkill.dispose(dollarSkillSessionId),
			});
			const availableTitleModels = runtime.ctx.modelRegistry?.getAvailable?.() ?? [];
			const defaultTitleModel = availableTitleModels[0];
			const traditionalToSimplifiedProvider = createTraditionalToSimplifiedSettingsProvider({
				onPersisted: (enabled) => traditionalToSimplified.setEnabled(enabled),
			});
			const autoTitleProvider = createAutoTitleProvider(runtime, (model) => {
				const selected =
					model ||
					(defaultTitleModel ? `${defaultTitleModel.provider}/${defaultTitleModel.id}` : undefined);
				if (selected && autoTitleCoordinator) {
					autoTitleCoordinator.setModel(selected);
					return;
				}
				autoTitleCoordinator?.dispose();
				autoTitleCoordinator = selected ? createAutoTitleCoordinator(runtime, selected) : undefined;
			});
			try {
				const state = await applyPatchGuardProvider.storage.load({
					sessionId: runtime.ctx.sessionManager.getSessionId(),
					cwd: runtime.ctx.cwd,
				});
				await applyPatchGuardProvider.onLoad?.(state ?? {}, {
					sessionId: runtime.ctx.sessionManager.getSessionId(),
					cwd: runtime.ctx.cwd,
				});
			} catch (error) {
				runtime.ctx.ui.notify(
					`Unable to load Guard patch settings: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			const providers = () =>
				combineSettingsProviders([
					autoTitleProvider,
					applyPatchGuardProvider,
					createRtkSettingsProvider(rtk),
					dollarSkillProvider,
					traditionalToSimplifiedProvider,
					...listHePiSettings().filter((provider) => provider.id !== autoTitleProvider.id),
				]);
			const settingsContext = {
				sessionId: runtime.ctx.sessionManager.getSessionId(),
				cwd: runtime.ctx.cwd,
			};
			try {
				const state = await autoTitleProvider.storage.load(settingsContext);
				await autoTitleProvider.onLoad?.(state ?? {}, settingsContext);
			} catch (error) {
				runtime.ctx.ui.notify(
					`Unable to load HEPI automatic title settings: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			runtime.registry.registerLifecycle({
				id: "auto-title",
				cleanup: () => {
					autoTitleCoordinator?.dispose();
					autoTitleCoordinator = undefined;
				},
			});
			runtime.registry.registerModule({
				id: "auto-title",
				label: "Automatic Title",
				commands: ["auto-title"],
				open: () => {
					autoTitleCoordinator?.trigger(true);
				},
			});
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
					skill: async (items) => {
						disabledDollarSkillKeys = new Set(
							items.filter((item) => item.effectiveStatus === "disabled").map((item) => item.key),
						);
					},
				},
			});
			await loadoutController.load().catch((error) => {
				runtime.ctx.ui.notify(
					`Unable to load HEPI Loadout: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			});
			runtime.registry.registerLifecycle({
				id: "loadout",
				cleanup: () => loadoutController?.close(),
			});
			await rtk.start(runtime);
			runtime.registry.registerLifecycle({
				id: "rtk",
				cleanup: () => rtk.dispose(runtime.ctx.sessionManager.getSessionId()),
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
					const next = new SettingsController({ context, providers: [providers()] });
					settingsController = next;
					void next.load().then(
						() => host.requestRender(),
						(error) => {
							runtime.ctx.ui.notify(
								`Unable to load HEPI Settings: ${error instanceof Error ? error.message : String(error)}`,
								"error",
							);
							host.requestRender();
						},
					);
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
					await settingsController?.close();
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
	pi.on("session_start", (event) => {
		if (event.reason === "startup" || event.reason === "new") autoTitleCoordinator?.trigger();
	});
}
export * from "./api/index.js";
export * from "./modules/dollar-skill/index.js";
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
