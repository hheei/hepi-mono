import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configureSubagentCoordinator } from "@hheei/pi-ext-core";
import {
	getHepiRuntimeSettingsRegistry,
	HepiLifecycleController,
	hepiAuthenticatedModelSelectionOptions,
	registerHepiLifecycle,
	registerHepiSettings,
} from "../core/index.js";
import {
	AUTO_TITLE_FIELD,
	AUTO_TITLE_GROUP,
	AUTO_TITLE_MODEL_FIELD,
	createAutoTitleCoordinator,
	createAutoTitleSettingsProvider,
	parseModelRef,
} from "./module.js";

export default function piAutoTitleExtension(pi: ExtensionAPI): void {
	const settingsRegistry = getHepiRuntimeSettingsRegistry(pi);
	let coordinator: ReturnType<typeof createAutoTitleCoordinator> | undefined;
	let run: (() => void) | undefined;
	const lifecycle = new HepiLifecycleController({
		onStart: async (runtime) => {
			const completionController = new AbortController();
			const completionLifecycle = {
				pi,
				extension: runtime.ctx,
				signal: completionController.signal,
				resources: { add: () => undefined, cleanup: async () => [] },
			};
			configureSubagentCoordinator(completionLifecycle, { maxActiveTurns: 2 });
			runtime.registry.registerLifecycle({
				id: "auto-title-completions",
				cleanup: () => completionController.abort(),
			});
			const modelOptions = hepiAuthenticatedModelSelectionOptions(runtime.ctx.modelRegistry);
			const provider = createAutoTitleSettingsProvider({
				modelOptions,
				validate: async (value) => {
					const ref = parseModelRef(value);
					const model = runtime.ctx.modelRegistry.find(ref.provider, ref.model);
					if (!model || !runtime.ctx.modelRegistry.hasConfiguredAuth(model))
						throw new Error(`Unavailable title model: ${value}`);
				},
			});
			const unregisterSettings = registerHepiSettings(provider, settingsRegistry);
			runtime.registry.registerLifecycle({
				id: "auto-title-settings",
				cleanup: unregisterSettings,
			});
			try {
				const context = {
					sessionId: runtime.ctx.sessionManager.getSessionId(),
					cwd: runtime.ctx.cwd,
				};
				const state = await provider.storage.load(context);
				const values = state?.[AUTO_TITLE_GROUP] ?? {};
				if (values[AUTO_TITLE_FIELD] === true) {
					const configured = values[AUTO_TITLE_MODEL_FIELD];
					const model = typeof configured === "string" && configured ? configured : undefined;
					if (model !== undefined) await provider.onLoad?.(state ?? {}, context);
					const selected = model ?? modelOptions.find((option) => option.value !== "")?.value;
					coordinator =
					selected === undefined
						? undefined
						: createAutoTitleCoordinator({ ...runtime, lifecycle: completionLifecycle }, selected);
				}
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
	registerHepiLifecycle(pi, lifecycle, "pi-basics-auto-title");
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
