import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	type ExtensionLifecycleContext,
	ensureSubagentCoordinator,
	getHepiRuntimeSettingsRegistry,
	type HepiSettingsProvider,
	type HepiSettingsState,
	hepiAuthenticatedModelSelectionOptions,
	observeLoadoutHost,
	observeLoadoutToolActivation,
	registerExtensionLifecycle,
	registerHepiSettings,
	registerLoadoutResource,
} from "@hheei/pi-ext-core";
import {
	AUTO_TITLE_FIELD,
	AUTO_TITLE_GROUP,
	AUTO_TITLE_MODEL_FIELD,
	createAutoTitleCoordinator,
	createAutoTitleSettingsProvider,
	parseModelRef,
} from "./module.js";

function createSettingsDetail(
	provider: HepiSettingsProvider,
	runtime: ExtensionLifecycleContext,
	getState: () => HepiSettingsState,
	setState: (state: HepiSettingsState) => void,
) {
	let selected = 0;
	const fields = provider.groups[0]?.fields ?? [];
	const context = {
		sessionId: runtime.extension.sessionManager.getSessionId(),
		cwd: runtime.extension.cwd,
	};
	const save = async (fieldIndex: number): Promise<void> => {
		const field = fields[fieldIndex];
		if (field === undefined) return;
		const values = getState()[AUTO_TITLE_GROUP] ?? {};
		const current = values[field.id];
		let next: boolean | string;
		if (field.type === "boolean") next = current !== true;
		else {
			const options = field.options ?? [];
			const index = options.findIndex((option) => option.value === current);
			next = String(options[(index + 1 + options.length) % options.length]?.value ?? "");
		}
		const nextState: HepiSettingsState = {
			...getState(),
			[AUTO_TITLE_GROUP]: { ...values, [field.id]: next },
		};
		const change = {
			groupId: AUTO_TITLE_GROUP,
			fieldId: field.id,
			value: next,
			...(current === undefined ? {} : { previousValue: current }),
			state: nextState,
		};
		setState(nextState);
		await provider.onChange?.(change, context);
		await provider.storage.save(nextState, context);
	};
	return {
		render(width: number): readonly string[] {
			const state = getState();
			const values = state[AUTO_TITLE_GROUP] ?? {};
			return fields
				.flatMap((field, index) => {
					const value = values[field.id] ?? field.defaultValue;
					const display =
						value === null ? "" : (field.formatDisplay?.(value, undefined) ?? String(value));
					return [`${index === selected ? "→" : " "} ${field.label}: ${display}`];
				})
				.map((line) => truncateToWidth(line, Math.max(0, width)));
		},
		async handleInput(input: string): Promise<boolean> {
			if (matchesKey(input, Key.up)) selected = Math.max(0, selected - 1);
			else if (matchesKey(input, Key.down)) selected = Math.min(fields.length - 1, selected + 1);
			else if (matchesKey(input, Key.space) || matchesKey(input, Key.enter)) await save(selected);
			else return false;
			return true;
		},
	};
}

export default function piAutoTitleExtension(pi: ExtensionAPI): void {
	let coordinator: ReturnType<typeof createAutoTitleCoordinator> | undefined;
	let run: (() => void) | undefined;
	const start = async (runtime: ExtensionLifecycleContext): Promise<void> => {
		// Core owns lifecycle ordering and settings registration; this package owns
		// model selection, title policy, and the coordinator's transient job state.
		ensureSubagentCoordinator(runtime);
		const modelOptions = hepiAuthenticatedModelSelectionOptions(runtime.extension.modelRegistry);
		let loadoutActive = true;
		let settingsState: HepiSettingsState = {
			[AUTO_TITLE_GROUP]: { [AUTO_TITLE_FIELD]: false, [AUTO_TITLE_MODEL_FIELD]: "" },
		};
		const disposeCoordinator = (): void => {
			coordinator?.dispose();
			coordinator = undefined;
		};
		const ensureCoordinator = (model?: string): void => {
			if (!loadoutActive || settingsState[AUTO_TITLE_GROUP]?.[AUTO_TITLE_FIELD] !== true) {
				disposeCoordinator();
				return;
			}
			const selected = model || modelOptions.find((option) => option.value !== "")?.value;
			if (selected === undefined) return;
			if (coordinator === undefined) {
				coordinator = createAutoTitleCoordinator(
					{ pi, ctx: runtime.extension, lifecycle: runtime },
					selected,
				);
			} else coordinator.setModel(selected);
		};
		const provider = createAutoTitleSettingsProvider({
			modelOptions,
			validate: async (value) => {
				const ref = parseModelRef(value);
				const model = runtime.extension.modelRegistry.find(ref.provider, ref.model);
				if (!model || !runtime.extension.modelRegistry.hasConfiguredAuth(model))
					throw new Error(`Unavailable title model: ${value}`);
			},
			prepareEnable: (model) => ensureCoordinator(model),
			onSettingsChange: (enabled, model) => {
				if (!enabled) disposeCoordinator();
				else ensureCoordinator(model);
			},
		});
		const settingsRegistry = getHepiRuntimeSettingsRegistry(pi);
		const detail = createSettingsDetail(
			provider,
			runtime,
			() => settingsState,
			(next) => {
				settingsState = next;
			},
		);
		let disposeSettings: (() => void) | undefined;
		let disposeResource: (() => void) | undefined;
		const setHost = (active: boolean): void => {
			if (active) {
				disposeSettings?.();
				disposeSettings = undefined;
				disposeResource?.();
				disposeResource = registerLoadoutResource(pi, {
					id: "agent:auto-title",
					kind: "agent",
					group: "hepi",
					label: "Auto Title",
					description: "Generate concise session titles automatically after settled turns.",
					summary: "Automatic session titles",
					owner: "@hheei/pi-auto-title",
					priority: 50,
					conflictSets: [],
					defaultActive: true,
					projectPrivate: false,
					detail,
				});
			} else {
				disposeResource?.();
				disposeResource = undefined;
				disposeSettings = registerHepiSettings(provider, settingsRegistry);
			}
		};
		observeLoadoutHost(pi, { signal: runtime.signal, onChange: setHost });
		observeLoadoutToolActivation(pi, {
			signal: runtime.signal,
			onChange(snapshot) {
				loadoutActive =
					snapshot === undefined ||
					!snapshot.knownIds.has("agent:auto-title") ||
					snapshot.activeIds.has("agent:auto-title");
				if (!loadoutActive) disposeCoordinator();
				else ensureCoordinator();
			},
		});
		try {
			const context = {
				sessionId: runtime.extension.sessionManager.getSessionId(),
				cwd: runtime.extension.cwd,
			};
			const state = await provider.storage.load(context);
			const values = state?.[AUTO_TITLE_GROUP] ?? {};
			settingsState = {
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
				if (model !== undefined) await provider.onLoad?.(state ?? {}, context);
				const selected = model ?? modelOptions.find((option) => option.value !== "")?.value;
				ensureCoordinator(selected);
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
					loadoutActive
						? "Unable to generate title: no authenticated model is available"
						: "Unable to generate title: Auto Title is disabled in Loadout",
					"warning",
				);
				return;
			}
			coordinator.trigger(true);
		};
		runtime.resources.add("auto-title", () => {
			disposeCoordinator();
			disposeSettings?.();
			disposeResource?.();
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
