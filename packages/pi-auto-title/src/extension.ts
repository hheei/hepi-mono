import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getHePiRuntimeSettingsRegistry,
	HePiLifecycleController,
	hePiAuthenticatedModelSelectionOptions,
	registerHePiLifecycle,
	registerHePiSettings,
} from "@hheei/pi-basics";
import {
	createAutoTitleCoordinator,
	createAutoTitleSettingsProvider,
	parseModelRef,
} from "./module.js";

export default function piAutoTitleExtension(pi: ExtensionAPI): void {
	const settingsRegistry = getHePiRuntimeSettingsRegistry(pi);
	let coordinator: ReturnType<typeof createAutoTitleCoordinator> | undefined;
	let run: (() => void) | undefined;
	let settingsProvider: ReturnType<typeof createAutoTitleSettingsProvider> | undefined;
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			const modelOptions = hePiAuthenticatedModelSelectionOptions(runtime.ctx.modelRegistry);
			const provider =
				settingsProvider ??
				createAutoTitleSettingsProvider({
					path: join(runtime.ctx.cwd, ".pi", "settings.json"),
					modelOptions,
					validate: async (value) => {
						const ref = parseModelRef(value);
						const model = runtime.ctx.modelRegistry.find(ref.provider, ref.model);
						if (!model || !runtime.ctx.modelRegistry.hasConfiguredAuth(model))
							throw new Error(`Unavailable title model: ${value}`);
					},
					onPersisted: (model) => {
						coordinator?.dispose();
						const selected = model ?? modelOptions.find((option) => option.value !== "")?.value;
						coordinator =
							selected === undefined ? undefined : createAutoTitleCoordinator(runtime, selected);
					},
				});
			if (settingsProvider === undefined) settingsProvider = provider;
			const unregisterSettings = registerHePiSettings(provider, settingsRegistry);
			runtime.registry.registerLifecycle({
				id: "auto-title-settings",
				cleanup: unregisterSettings,
			});
			try {
				const state = await provider.storage.load({
					sessionId: runtime.ctx.sessionManager.getSessionId(),
					cwd: runtime.ctx.cwd,
				});
				await provider.onLoad?.(state ?? {}, {
					sessionId: runtime.ctx.sessionManager.getSessionId(),
					cwd: runtime.ctx.cwd,
				});
			} catch (error) {
				runtime.ctx.ui.notify(
					`Unable to load HEPI automatic title settings: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			run = () => {
				if (coordinator === undefined) {
					runtime.ctx.ui.notify(
						"Unable to generate title: no authenticated model is available",
						"warning",
					);
					return;
				}
				coordinator.trigger(true);
			};
			runtime.registry.registerLifecycle({
				id: "auto-title",
				cleanup: () => {
					coordinator?.dispose();
					coordinator = undefined;
					run = undefined;
				},
			});
		},
	});
	pi.registerCommand("auto-title", {
		description: "Generate or replace the current session title",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/auto-title requires TUI mode", "error");
				return;
			}
			run?.();
		},
	});
	registerHePiLifecycle(pi, lifecycle);
	pi.on("session_info_changed", (event) => {
		coordinator?.sessionInfoChanged(event.name);
	});
	pi.on("before_agent_start", () => {
		coordinator?.beforeAgentStart();
	});
	pi.on("agent_settled", () => {
		coordinator?.agentSettled();
	});
	pi.on("session_start", (event) => {
		if (event.reason === "startup" || event.reason === "new") coordinator?.trigger();
	});
}
