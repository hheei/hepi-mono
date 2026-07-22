import type {
	HePiContext,
	HePiSettingField,
	HePiSettingsProvider,
	HePiSettingsState,
} from "../../api/settings.js";
import { loadRtkConfig, saveRtkConfig } from "./config.js";
import type { RtkFeature } from "./feature.js";

const GROUP = "rtk";
type RtkModeSetting = "off" | "rewrite" | "suggest";
type RtkCompactionSetting = "none" | "out" | "read+out";

const fields: readonly HePiSettingField[] = [
	{
		id: "mode",
		label: "RTK Mode",
		type: "enum",
		defaultValue: "rewrite",
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
		options: [
			{ value: "none", label: "none" },
			{ value: "out", label: "out" },
			{ value: "read+out", label: "read+out" },
		],
		parse: (value): RtkCompactionSetting =>
			value === "none" || value === "read+out" ? value : "out",
	},
];

export function createRtkSettingsProvider(feature: RtkFeature): HePiSettingsProvider {
	return {
		id: "pi-basics-rtk",
		title: "RTK",
		origin: "@pi-basics",
		description: "RTK command rewriting and tool output compaction.",
		groups: [{ id: GROUP, title: "", fields }],
		storage: {
			async load(ctx: HePiContext) {
				const config = (await loadRtkConfig(ctx.cwd ?? process.cwd())).config;
				return {
					[GROUP]: {
						mode: config.enabled ? config.mode : "off",
						compaction: !config.outputCompaction.enabled
							? "none"
							: config.outputCompaction.readCompaction.enabled
								? "read+out"
								: "out",
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
							enabled: compaction !== "none",
							readCompaction: {
								...config.outputCompaction.readCompaction,
								enabled: compaction === "read+out",
							},
						},
					};
				feature.setConfig(config);
				await saveRtkConfig(ctx.cwd ?? process.cwd(), config);
			},
		},
	};
}
