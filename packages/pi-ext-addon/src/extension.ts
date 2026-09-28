import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	authenticatedModelSelectionOptions,
	ensureSubagentCoordinator,
	errorMessage,
	getRuntimeSettingsRegistry,
	isSkillEnabled,
	registerExtensionLifecycle,
	registerSettings,
	type SettingsState,
} from "@hheei/pi-ext-core";
import {
	AUTO_TITLE_FIELD,
	AUTO_TITLE_GROUP,
	AUTO_TITLE_MODEL_FIELD,
	type AutoTitleCoordinator,
	createAutoTitleCoordinator,
	createAutoTitleSettingsProvider,
	parseModelRef,
} from "./auto-title.js";
import {
	createDollarSkillFeature,
	createDollarSkillSettingsProvider,
	loadDollarSkillConfig,
	registerDollarSkillInputTransform,
} from "./dollar-skill/index.js";

/** Registers Pi opt-in host enhancement features: dollar skill references and auto session titles. */
export default function piExtAddonExtension(pi: ExtensionAPI): void {
	const dollarSkill = createDollarSkillFeature(pi, (command) => isSkillEnabled(pi, command.name));
	registerDollarSkillInputTransform(pi, dollarSkill);
	const dollarSkillSettings = createDollarSkillSettingsProvider({
		onChange: (config) => dollarSkill.setConfig(config),
	});

	let autoTitleCoordinator: AutoTitleCoordinator | undefined;
	let runAutoTitle: (() => void) | undefined;
	// Pi emits `session_start` before the lifecycle handler of the same emit creates the coordinator,
	// so the request is recorded here and the coordinator is asked once it exists.
	let autoTitleWanted = false;

	pi.registerCommand("auto-title", {
		description: "Generate or replace the current session title",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/auto-title requires TUI mode", "error");
				return;
			}
			runAutoTitle?.();
		},
	});

	pi.on("session_info_changed", (event) => autoTitleCoordinator?.sessionInfoChanged(event.name));
	pi.on("before_agent_start", () => autoTitleCoordinator?.beforeAgentStart());
	pi.on("agent_settled", () => autoTitleCoordinator?.agentSettled());
	pi.on("session_start", (event) => {
		if (event.reason === "startup" || event.reason === "new") autoTitleWanted = true;
	});

	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-addon",
		start: async (runtime): Promise<void> => {
			const sessionId = runtime.extension.sessionManager.getSessionId();
			const settingsRegistry = getRuntimeSettingsRegistry(pi);

			// 1. Dollar skill (opt-in)
			runtime.resources.add(
				"dollar-skill-settings",
				registerSettings(dollarSkillSettings, settingsRegistry),
			);
			try {
				dollarSkill.setConfig(await loadDollarSkillConfig());
			} catch (error) {
				runtime.extension.ui.notify(
					`Unable to load dollar skill settings: ${errorMessage(error)}`,
					"error",
				);
			}
			dollarSkill.start(runtime.extension);
			runtime.resources.add("dollar-skill", () => dollarSkill.dispose(sessionId));

			// 2. Auto title (opt-in)
			ensureSubagentCoordinator(runtime);
			const modelOptions = authenticatedModelSelectionOptions(runtime.extension.modelRegistry);
			let autoTitleSettingsState: SettingsState = {
				[AUTO_TITLE_GROUP]: { [AUTO_TITLE_FIELD]: false, [AUTO_TITLE_MODEL_FIELD]: "" },
			};
			const disposeAutoTitleCoordinator = (): void => {
				autoTitleCoordinator?.dispose();
				autoTitleCoordinator = undefined;
			};
			const ensureAutoTitleCoordinator = (model?: string): void => {
				if (autoTitleSettingsState[AUTO_TITLE_GROUP]?.[AUTO_TITLE_FIELD] !== true) {
					disposeAutoTitleCoordinator();
					return;
				}
				const selected = model || modelOptions.find((option) => option.value !== "")?.value;
				if (selected === undefined) return;
				if (autoTitleCoordinator === undefined) {
					autoTitleCoordinator = createAutoTitleCoordinator(
						{ pi, ctx: runtime.extension, lifecycle: runtime },
						selected,
					);
				} else autoTitleCoordinator.setModel(selected);
			};
			const autoTitleProvider = createAutoTitleSettingsProvider({
				modelOptions,
				modelRegistry: runtime.extension.modelRegistry,
				validate: async (value) => {
					const ref = parseModelRef(value);
					const model = runtime.extension.modelRegistry.find(ref.provider, ref.model);
					if (!model || !runtime.extension.modelRegistry.hasConfiguredAuth(model))
						throw new Error(`Unavailable title model: ${value}`);
				},
				prepareEnable: (model) => ensureAutoTitleCoordinator(model),
				onSettingsChange: (enabled, model) => {
					if (!enabled) disposeAutoTitleCoordinator();
					else ensureAutoTitleCoordinator(model);
				},
			});
			runtime.resources.add(
				"auto-title-settings",
				registerSettings(autoTitleProvider, settingsRegistry),
			);
			try {
				const context = {
					sessionId,
					cwd: runtime.extension.cwd,
				};
				const state = await autoTitleProvider.storage.load(context);
				const values = state?.[AUTO_TITLE_GROUP] ?? {};
				autoTitleSettingsState = {
					[AUTO_TITLE_GROUP]: {
						[AUTO_TITLE_FIELD]: values[AUTO_TITLE_FIELD] === true,
						[AUTO_TITLE_MODEL_FIELD]:
							typeof values[AUTO_TITLE_MODEL_FIELD] === "string"
								? values[AUTO_TITLE_MODEL_FIELD]
								: "",
					},
				};
				if (values[AUTO_TITLE_FIELD] === true) {
					const configured = values[AUTO_TITLE_MODEL_FIELD];
					const model = typeof configured === "string" && configured ? configured : undefined;
					if (model !== undefined) await autoTitleProvider.onLoad?.(state ?? {}, context);
					const selected = model ?? modelOptions.find((option) => option.value !== "")?.value;
					ensureAutoTitleCoordinator(selected);
				}
			} catch (error) {
				runtime.extension.ui.notify(
					`Unable to load HEPI automatic title settings: ${errorMessage(error)}`,
					"error",
				);
			}
			// The session asked for a title before this start created the coordinator. A fresh session has
			// no request text yet, so the coordinator waits and generates it once the first turn settles.
			const wanted = autoTitleWanted;
			autoTitleWanted = false;
			if (wanted) autoTitleCoordinator?.trigger();
			runAutoTitle = () => {
				if (autoTitleCoordinator === undefined) {
					const configured = autoTitleSettingsState[AUTO_TITLE_GROUP]?.[AUTO_TITLE_MODEL_FIELD];
					const model = typeof configured === "string" && configured ? configured : undefined;
					const selected = model ?? modelOptions.find((option) => option.value !== "")?.value;
					if (selected !== undefined) {
						autoTitleCoordinator = createAutoTitleCoordinator(
							{ pi, ctx: runtime.extension, lifecycle: runtime },
							selected,
						);
					}
				}
				if (autoTitleCoordinator === undefined) {
					runtime.extension.ui.notify(
						"Unable to generate title: no authenticated model is available",
						"warning",
					);
					return;
				}
				autoTitleCoordinator.trigger(true);
			};
			runtime.resources.add("auto-title", () => {
				disposeAutoTitleCoordinator();
				runAutoTitle = undefined;
			});
		},
	});
}
