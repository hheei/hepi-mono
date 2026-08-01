import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	configureSubagentCoordinator,
	DEFAULT_SUBAGENT_COORDINATOR_BUDGET,
	type ExtensionLifecycleContext,
	getHepiRuntimeSettingsRegistry,
	hepiAuthenticatedModelSelectionOptions,
	registerExtensionLifecycle,
	registerHepiSettings,
} from "@hheei/pi-ext-core";
import {
	AUTO_TITLE_FIELD,
	AUTO_TITLE_GROUP,
	AUTO_TITLE_MODEL_FIELD,
	createAutoTitleCoordinator,
	createAutoTitleSettingsProvider,
	parseModelRef,
} from "./module.js";

export default function piAutoTitleExtension(pi: ExtensionAPI): void {
	let coordinator: ReturnType<typeof createAutoTitleCoordinator> | undefined;
	let run: (() => void) | undefined;
	const start = async (runtime: ExtensionLifecycleContext): Promise<void> => {
		// Core owns lifecycle ordering and settings registration; this package owns
		// model selection, title policy, and the coordinator's transient job state.
		configureSubagentCoordinator(runtime, DEFAULT_SUBAGENT_COORDINATOR_BUDGET);
		const modelOptions = hepiAuthenticatedModelSelectionOptions(runtime.extension.modelRegistry);
		const provider = createAutoTitleSettingsProvider({
			modelOptions,
			validate: async (value) => {
				const ref = parseModelRef(value);
				const model = runtime.extension.modelRegistry.find(ref.provider, ref.model);
				if (!model || !runtime.extension.modelRegistry.hasConfiguredAuth(model))
					throw new Error(`Unavailable title model: ${value}`);
			},
		});
		const settingsRegistry = getHepiRuntimeSettingsRegistry(pi);
		runtime.resources.add("auto-title-settings", registerHepiSettings(provider, settingsRegistry));
		try {
			const context = {
				sessionId: runtime.extension.sessionManager.getSessionId(),
				cwd: runtime.extension.cwd,
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
						: createAutoTitleCoordinator(
								{ pi, ctx: runtime.extension, lifecycle: runtime },
								selected,
							);
			}
		} catch (error) {
			runtime.extension.ui.notify(
				`Unable to load HEPI automatic title settings: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
		run = () => {
			if (coordinator === undefined) {
				runtime.extension.ui.notify(
					"Unable to generate title: no authenticated model is available",
					"warning",
				);
				return;
			}
			coordinator.trigger(true);
		};
		runtime.resources.add("auto-title", () => {
			coordinator?.dispose();
			coordinator = undefined;
			run = undefined;
		});
	};

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
	// Keep the historical key stable: changing it would leave a previous key's
	// lifecycle handler live during an in-process /reload.
	registerExtensionLifecycle(pi, { key: "pi-auto-title", start });
	// Pi has no public unregister for these feature hooks. They remain harmless
	// after /reload because the current coordinator is lifecycle-scoped and dispose
	// clears its timers, agent, and session revision.
	pi.on("session_info_changed", (event) => coordinator?.sessionInfoChanged(event.name));
	pi.on("before_agent_start", () => coordinator?.beforeAgentStart());
	pi.on("agent_settled", () => coordinator?.agentSettled());
	pi.on("session_start", (event) => {
		if (event.reason === "startup" || event.reason === "new") coordinator?.trigger();
	});
}
