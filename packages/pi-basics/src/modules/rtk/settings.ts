import type {
	HePiContext,
	HePiSettingField,
	HePiSettingsProvider,
	HePiSettingsState,
} from "../../api/settings.js";
import { loadRtkConfig, saveRtkConfig } from "./config.js";
import type { RtkFeature } from "./feature.js";
import type { RtkIntegrationConfig } from "./types.js";

const GROUP = "rtk";
type RtkSettingId = "enabled" | "mode" | "outputCompaction" | "readCompaction";
const paths: Record<RtkSettingId, string> = {
	enabled: "enabled",
	mode: "mode",
	outputCompaction: "outputCompaction.enabled",
	readCompaction: "outputCompaction.readCompaction.enabled",
};

const fields: readonly HePiSettingField[] = [
	{
		id: "enabled",
		label: "Enabled",
		type: "boolean",
		defaultValue: true,
		parse: (value) => value === "true",
	},
	{
		id: "mode",
		label: "Mode",
		type: "enum",
		defaultValue: "rewrite",
		options: [
			{ value: "rewrite", label: "rewrite" },
			{ value: "suggest", label: "suggest" },
		],
		parse: (value) => (value === "suggest" ? "suggest" : "rewrite"),
	},
	{
		id: "outputCompaction",
		label: "Output compaction",
		type: "boolean",
		defaultValue: true,
		parse: (value) => value === "true",
	},
	{
		id: "readCompaction",
		label: "Read compaction",
		type: "boolean",
		defaultValue: false,
		description: "Keep disabled unless you accept lossy read output.",
		parse: (value) => value === "true",
	},
];

function readPath(config: RtkIntegrationConfig, path: string): unknown {
	return path
		.split(".")
		.reduce((value: unknown, key) => (value as Record<string, unknown> | undefined)?.[key], config);
}

function writePath(config: RtkIntegrationConfig, path: string, value: unknown): RtkIntegrationConfig {
	const next = structuredClone(config) as unknown as Record<string, unknown>;
	const parts = path.split(".");
	let target = next;
	for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
	target[parts.at(-1)!] = value;
	return next as unknown as RtkIntegrationConfig;
}

export function createRtkSettingsProvider(feature: RtkFeature): HePiSettingsProvider {
	return {
		id: "pi-basics-rtk",
		title: "RTK",
		origin: "@pi-basics",
		description: "RTK command rewriting and tool output compaction.",
		groups: [{ id: GROUP, title: "RTK", fields }],
		storage: {
			async load(ctx: HePiContext) {
				const config = (await loadRtkConfig(ctx.cwd ?? process.cwd())).config;
				return {
					[GROUP]: Object.fromEntries(
						(Object.keys(paths) as RtkSettingId[]).map((id) => [id, readPath(config, paths[id])]),
					),
				} as HePiSettingsState;
			},
			async save(state: HePiSettingsState, ctx: HePiContext) {
				let config = feature.getConfig();
				for (const id of Object.keys(paths) as RtkSettingId[]) {
					const value = state[GROUP]?.[id];
					if (value !== undefined) config = writePath(config, paths[id], value);
				}
				feature.setConfig(config);
				await saveRtkConfig(ctx.cwd ?? process.cwd(), config);
			},
		},
	};
}
