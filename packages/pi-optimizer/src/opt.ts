import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingsProvider, SettingsState } from "@hheei/pi-ext-core";
import type { OptimizerInfo } from "./info.js";
import { type OptimizerSettings, parseOptimizerSettings } from "./settings.js";

export interface OptimizerSession {
	settings: OptimizerSettings;
	readonly signal: AbortSignal;
	readonly provider: SettingsProvider;
	update(transform: (settings: OptimizerSettings) => OptimizerSettings): Promise<void>;
}

/** Both command arguments and native dialogs use the provider's actual fields. */
export function registerOptimizerCommand(
	pi: Pick<ExtensionAPI, "registerCommand">,
	getSession: (context: ExtensionContext) => OptimizerSession | undefined,
	info: OptimizerInfo,
): void {
	pi.registerCommand("optimizer", {
		description: "Configure T2S, prompt modes, and opt-in RTK rewriting",
		handler: async (rawArgs, context): Promise<void> => {
			const session = getSession(context);
			if (!session) return info("Optimizer is not active for this session", undefined, true);
			const controls = session.provider.groups.flatMap((group) =>
				group.fields.map((field) => ({
					group: group.id,
					field,
					command: field.type === "path" ? `${group.id}-${field.id}` : group.id,
					title: field.type === "path" ? field.label : group.title,
					values: field.options?.map((option) => String(option.value)) ?? ["on", "off"],
				})),
			);
			const label = (control: (typeof controls)[number]): string => {
				const state: SettingsState = session.settings;
				const value = state[control.group]?.[control.field.id];
				return `${control.title}: ${typeof value === "boolean" ? (value ? "on" : "off") : stripVTControlCharacters(String(value ?? "")).replace(/\s+/gu, " ") || "(auto)"}`;
			};
			const save = async (command: string, rawValue: string): Promise<void> => {
				try {
					const control = controls.find((item) => item.command === command);
					if (!control || (control.field.type !== "path" && !control.values.includes(rawValue)))
						throw new Error("Invalid optimizer parameters");
					const value = control.field.parse(
						control.field.type === "boolean" ? String(rawValue === "on") : rawValue,
					);
					await session.update((current) => {
						const state: SettingsState = current;
						return parseOptimizerSettings({
							...state,
							[control.group]: { ...state[control.group], [control.field.id]: value },
						});
					});
				} catch (error) {
					if (!session.signal.aborted)
						info(
							`Unable to save optimizer settings: ${error instanceof Error ? error.message : String(error)}`,
							undefined,
							true,
						);
				}
			};
			const args = rawArgs.trim();
			if (args === "status" || (args === "" && context.mode !== "tui"))
				return info(controls.map(label).join(" · "), session.settings);
			if (args) {
				const separator = args.search(/\s/u);
				await save(
					separator < 0 ? args : args.slice(0, separator),
					separator < 0 ? "" : args.slice(separator).trim(),
				);
				return;
			}
			const options = { signal: session.signal };
			while (!session.signal.aborted) {
				const labels = controls.map(label);
				const selected = await context.ui.select("Optimizer", [...labels, "Close"], options);
				if (selected === undefined || selected === "Close" || session.signal.aborted) return;
				const control = controls[labels.indexOf(selected)];
				if (!control) return;
				const value =
					control.field.type === "path"
						? await context.ui.input(
								"RTK executable path (empty = PATH)",
								session.settings.rtk.path,
								options,
							)
						: await context.ui.select(label(control), control.values, options);
				if (session.signal.aborted) return;
				if (value !== undefined) await save(control.command, value.trim());
			}
		},
	});
}
