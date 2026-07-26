import {
	createHePiModelSelectionField,
	createJsonSectionSettingsStorage,
	type HePiModelSelectionOption,
	type HePiSettingsProvider,
	type HePiSettingValue,
} from "../hepi-basics/index.js";
import { parseThinking } from "./model.js";
export function createAdvisorSettingsProvider(options: {
	readonly path?: string;
	readonly modelOptions?: readonly HePiModelSelectionOption[];
	readonly validatePersisted?: (
		model: string | undefined,
		thinking: string,
	) => void | Promise<void>;
	readonly onPersisted?: (model: string | undefined, thinking: string) => void | Promise<void>;
}): HePiSettingsProvider {
	const storage = createJsonSectionSettingsStorage({
		...(options.path === undefined ? {} : { path: options.path }),
		section: "pi-basics",
		group: "advisor",
	});
	return {
		id: "pi-basics-advisor",
		title: "Advisor",
		origin: "@hheei/pi-basics",
		description: "Read-only turn review using the selected external model provider.",
		groups: [
			{
				id: "advisor",
				title: "",
				fields: [
					createHePiModelSelectionField({
						id: "model",
						label: "Advisor model",
						description:
							"Select the authenticated model that receives resolved session context, turn evidence, and project files read during Advisor reviews.",
						modelOptions: options.modelOptions ?? [{ value: "", label: "Not set" }],
						thinking: {
							fieldId: "thinking",
							label: "Thinking",
							description:
								"Set the reasoning intensity used by the selected Advisor model during reviews.",
							defaultValue: "medium",
							options: [
								{ value: "off", label: "off" },
								{ value: "minimal", label: "minimal" },
								{ value: "low", label: "low" },
								{ value: "medium", label: "medium" },
								{ value: "high", label: "high" },
								{ value: "xhigh", label: "xhigh" },
							],
						},
					}),
				],
			},
		],
		storage: {
			async load(ctx) {
				const state = await storage.load(ctx);
				return state?.advisor ? { advisor: state.advisor } : undefined;
			},
			async validate(state) {
				const values = state.advisor;
				const rawModel = typeof values?.model === "string" ? values.model.trim() : "";
				const model = rawModel.length > 0 ? rawModel : undefined;
				const thinking =
					typeof values?.thinking === "string" ? parseThinking(values.thinking) : undefined;
				if (thinking === undefined) throw new Error("Invalid thinking level");
				await options.validatePersisted?.(model, thinking);
			},
			async save(state, ctx) {
				const values = state.advisor;
				const rawModel = typeof values?.model === "string" ? values.model.trim() : "";
				const model = rawModel.length > 0 ? rawModel : undefined;
				const thinking =
					typeof values?.thinking === "string" ? parseThinking(values.thinking) : undefined;
				if (thinking === undefined) throw new Error("Invalid thinking level");
				await options.validatePersisted?.(model, thinking);
				const advisor: Record<string, HePiSettingValue> = { thinking };
				for (const [key, value] of Object.entries(values ?? {})) {
					if (key !== "model") advisor[key] = value;
				}
				if (model !== undefined) advisor.model = model;
				await storage.save({ advisor }, ctx);
				await options.onPersisted?.(model, thinking);
			},
		},
	};
}
