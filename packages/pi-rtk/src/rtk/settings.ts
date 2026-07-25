import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	HePiSettingField,
	HePiSettingsProvider,
	HePiSettingsState,
} from "@hheei/pi-basics";
import { loadRtkConfig, saveRtkConfig } from "./config.js";
import type { RtkFeature } from "./feature.js";

const GROUP = "rtk";
type RtkModeSetting = "off" | "rewrite" | "suggest";
type RtkCompactionSetting = "out" | "read+out";

const fields: readonly HePiSettingField[] = [
	{
		id: "mode",
		label: "RTK Mode",
		type: "enum",
		defaultValue: "rewrite",
		description:
			"Choose whether RTK rewrites supported shell commands, suggests replacements, or stays disabled.",
		options: [
			{ value: "off", label: "off" },
			{ value: "rewrite", label: "rewrite" },
			{ value: "suggest", label: "suggest" },
		],
		parse: (value): RtkModeSetting => (value === "off" || value === "suggest" ? value : "rewrite"),
	},
	{
		id: "compaction",
		label: "RTK Compaction",
		type: "enum",
		defaultValue: "out",
		description:
			"Choose whether RTK compacts command output only or also compacts supported file-read output.",
		options: [
			{ value: "out", label: "out" },
			{ value: "read+out", label: "read+out" },
		],
		parse: (value): RtkCompactionSetting => (value === "read+out" ? "read+out" : "out"),
		enabled: (state) => state[GROUP]?.mode !== "off",
	},
];

export function createRtkSettingsProvider(
	feature: RtkFeature,
	agentDir: string = getAgentDir(),
): HePiSettingsProvider {
	return {
		id: "pi-basics-rtk",
		title: "RTK",
		origin: "@pi-rtk",
		description: "RTK command rewriting and tool output compaction.",
		groups: [{ id: GROUP, title: "", fields }],
		storage: {
			async load(ctx: HePiContext) {
				const config = (await loadRtkConfig(agentDir)).config;
				return {
					[GROUP]: {
						mode: config.enabled ? config.mode : "off",
						compaction: config.outputCompaction.readCompaction.enabled ? "read+out" : "out",
					},
				} as HePiSettingsState;
			},
			async save(state: HePiSettingsState, ctx: HePiContext) {
				let config = feature.getConfig();
				const mode = state[GROUP]?.mode as RtkModeSetting | undefined;
				if (mode !== undefined) {
					config = { ...config, enabled: mode !== "off" };
					if (mode !== "off") config = { ...config, mode };
				}
				const compaction = state[GROUP]?.compaction as RtkCompactionSetting | undefined;
				if (compaction !== undefined)
					config = {
						...config,
						outputCompaction: {
							...config.outputCompaction,
							enabled: true,
							readCompaction: {
								...config.outputCompaction.readCompaction,
								enabled: compaction === "read+out",
							},
						},
					};
				feature.setConfig(config);
				await saveRtkConfig(agentDir, config);
			},
		},
	};
}
