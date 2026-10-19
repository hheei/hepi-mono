import { createJsonSettingsStorage, type SettingsProvider } from "@hheei/pi-ext-core";
import { readGlobalSettingsGroup } from "./global-settings.js";

const GROUP = "eval";

export const DEFAULT_EVAL_PYTHON_BIN = "";

export interface EvalSettingsProviderOptions {
	readonly path?: string;
}

/** Reads eval configuration without dynamic enablement flags. */
export function readEvalSettings(path?: string): {
	readonly pythonBin: string | undefined;
} {
	const fields = readGlobalSettingsGroup(GROUP, path);
	const pythonBin = typeof fields?.pythonBin === "string" ? fields.pythonBin.trim() : "";
	return {
		pythonBin: pythonBin === "" ? undefined : pythonBin,
	};
}

export function createEvalSettingsProvider(
	options: EvalSettingsProviderOptions = {},
): SettingsProvider {
	return {
		id: "pi-python-eval.eval",
		title: "Eval",
		origin: "@hheei/pi-python-eval",
		description: "Configure Python interpreter for trusted local Python Eval.",
		groups: [
			{
				id: GROUP,
				title: "",
				fields: [
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
