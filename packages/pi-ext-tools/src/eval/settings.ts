import { readFileSync } from "node:fs";
import {
	createJsonSectionSettingsStorage,
	defaultPiSettingsPaths,
	type SettingsProvider,
} from "@hheei/pi-ext-core";

const SECTION = "pi-ext-tools";
const GROUP = "eval";

export const DEFAULT_EVAL_ENABLED = false;
export const DEFAULT_EVAL_CODE_MODE = false;
export const DEFAULT_EVAL_PYTHON_BIN = "";

export interface EvalSettingsProviderOptions {
	readonly path?: string;
}

/** Eval activation is static so historical renderers always exist before resume rendering. */
export function readEvalSettings(path = defaultPiSettingsPaths().globalPath): {
	readonly enabled: boolean;
	readonly codeMode: boolean;
	readonly pythonBin: string | undefined;
} {
	try {
		const root: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof root !== "object" || root === null || Array.isArray(root))
			return {
				enabled: DEFAULT_EVAL_ENABLED,
				codeMode: DEFAULT_EVAL_CODE_MODE,
				pythonBin: undefined,
			};
		const section = (root as Record<string, unknown>)[SECTION];
		if (typeof section !== "object" || section === null || Array.isArray(section))
			return {
				enabled: DEFAULT_EVAL_ENABLED,
				codeMode: DEFAULT_EVAL_CODE_MODE,
				pythonBin: undefined,
			};
		const evalSettings = (section as Record<string, unknown>)[GROUP];
		if (typeof evalSettings !== "object" || evalSettings === null || Array.isArray(evalSettings))
			return {
				enabled: DEFAULT_EVAL_ENABLED,
				codeMode: DEFAULT_EVAL_CODE_MODE,
				pythonBin: undefined,
			};
		const fields = evalSettings as Record<string, unknown>;
		const pythonBin = typeof fields.pythonBin === "string" ? fields.pythonBin.trim() : "";
		return {
			enabled: fields.enabled === true,
			codeMode: fields.codeMode === true,
			pythonBin: pythonBin === "" ? undefined : pythonBin,
		};
	} catch {
		return {
			enabled: DEFAULT_EVAL_ENABLED,
			codeMode: DEFAULT_EVAL_CODE_MODE,
			pythonBin: undefined,
		};
	}
}

export function readEvalEnabled(path = defaultPiSettingsPaths().globalPath): boolean {
	return readEvalSettings(path).enabled;
}

export function createEvalSettingsProvider(
	options: EvalSettingsProviderOptions = {},
): SettingsProvider {
	return {
		id: "pi-ext-tools.eval",
		title: "Eval",
		origin: "@hheei/pi-ext-tools",
		description: "Enable trusted local JavaScript or Python Eval after reload or a new session.",
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
							"Run trusted local Python by default; JavaScript/TypeScript requires a Bun host. This is not a sandbox and is disabled by default.",
						parse: (value) => value === "true",
					},
					{
						id: "codeMode",
						label: "Enable Code Mode",
						type: "boolean",
						defaultValue: DEFAULT_EVAL_CODE_MODE,
						description:
							"Reserve the explicit Code Mode activation after reload or a new session. It has no runtime effect until Code Mode is implemented.",
						parse: (value) => value === "true",
					},
					{
						id: "pythonBin",
						label: "Python interpreter",
						type: "path",
						defaultValue: DEFAULT_EVAL_PYTHON_BIN,
						description:
							"Interpreter used by the default Python kernel. Empty uses python3 or python on PATH. Changes apply after reload or a new session.",
						parse: (value) => value.trim(),
					},
				],
			},
		],
		storage: createJsonSectionSettingsStorage({
			...(options.path === undefined ? {} : { path: options.path }),
			section: SECTION,
			group: GROUP,
		}),
	};
}
