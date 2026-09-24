import { readFileSync } from "node:fs";
import {
	createJsonSettingsStorage,
	defaultExtensionSettingsPaths,
	type SettingsProvider,
} from "@hheei/pi-ext-core";

const GROUP = "eval";

export const DEFAULT_EVAL_ENABLED = false;
export const DEFAULT_EVAL_PYTHON_BIN = "";

export interface EvalSettingsProviderOptions {
	readonly path?: string;
}

/** Eval activation is static so historical renderers always exist before resume rendering. */
export function readEvalSettings(path = defaultExtensionSettingsPaths().globalPath): {
	readonly enabled: boolean;
	readonly pythonBin: string | undefined;
} {
	try {
		const root: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof root !== "object" || root === null || Array.isArray(root))
			return {
				enabled: DEFAULT_EVAL_ENABLED,
				pythonBin: undefined,
			};
		const evalSettings = (root as Record<string, unknown>)[GROUP];
		if (typeof evalSettings !== "object" || evalSettings === null || Array.isArray(evalSettings))
			return {
				enabled: DEFAULT_EVAL_ENABLED,
				pythonBin: undefined,
			};
		const fields = evalSettings as Record<string, unknown>;
		const pythonBin = typeof fields.pythonBin === "string" ? fields.pythonBin.trim() : "";
		return {
			enabled: fields.enabled === true,
			pythonBin: pythonBin === "" ? undefined : pythonBin,
		};
	} catch {
		return {
			enabled: DEFAULT_EVAL_ENABLED,
			pythonBin: undefined,
		};
	}
}

export function createEvalSettingsProvider(
	options: EvalSettingsProviderOptions = {},
): SettingsProvider {
	return {
		id: "pi-ext-tools.eval",
		title: "Eval",
		origin: "@hheei/pi-ext-tools",
		description: "Enable trusted local Python Eval after reload or a new session.",
		groups: [
			{
				id: GROUP,
				title: "",
				fields: [
					{
						id: "enabled",
						label: "Enable Eval",
						type: "boolean",
						defaultValue: DEFAULT_EVAL_ENABLED,
						description:
							"Run trusted local Python. This is not a sandbox and is disabled by default.",
						parse: (value) => value === "true",
					},
					{
						id: "pythonBin",
						label: "Python interpreter",
						type: "path",
						defaultValue: DEFAULT_EVAL_PYTHON_BIN,
						description:
							"Interpreter used by the default Python kernel. (auto) uses python3 or python on PATH. Changes apply after reload or a new session.",
						format: (value) => (value ? String(value) : "(auto)"),
						parse: (value) => value.trim(),
					},
				],
			},
		],
		storage: createJsonSettingsStorage({
			...(options.path === undefined ? {} : { path: options.path }),
			group: GROUP,
		}),
	};
}
