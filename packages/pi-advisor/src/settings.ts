import {
	createJsonSectionSettingsStorage,
	type HePiSettingsProvider,
	type HePiSettingValue,
} from "@hheei/pi-basics";
import { parseModelRef, parseThinking } from "./model.js";
export function createAdvisorSettingsProvider(options: {
	readonly path: string;
	readonly modelOptions?: readonly { readonly value: string; readonly label: string }[];
	readonly validatePersisted?: (
		model: string | undefined,
		thinking: string,
	) => void | Promise<void>;
	readonly onPersisted?: (model: string | undefined, thinking: string) => void | Promise<void>;
}): HePiSettingsProvider {
	const storage = createJsonSectionSettingsStorage({
		path: options.path,
		section: "pi-basics",
		group: "advisor",
	});
	return {
		id: "pi-basics-advisor",
		title: "Advisor",
		origin: "@hheei/pi-basics",
		description: "Read-only turn review.",
		groups: [
			{
				id: "advisor",
				title: "",
				fields: [
					{
						id: "model",
						label: "Advisor model",
						type: "enum",
						defaultValue: "",
						description:
							"Select the authenticated model used for read-only Advisor reviews after settled turns.",
						options: options.modelOptions ?? [{ value: "", label: "Not set" }],
						format: (value) => {
							if (typeof value !== "string") return String(value);
							return (
								(options.modelOptions ?? []).find((option) => option.value === value)?.label ??
								(value || "Not set")
							);
						},
						parse: (value) => value,
						validate: (value) =>
							typeof value === "string" && value.length > 0 && !parseModelRef(value)
								? "Use provider/model"
								: undefined,
						tabCycle: {
							fieldId: "thinking",
							label: "Thinking",
							description:
								"Set the reasoning intensity used by the selected Advisor model during reviews.",
							defaultValue: "medium",
							options: ["off", "minimal", "low", "medium", "high", "xhigh"].map((value) => ({
								value,
								label: value,
							})),
						},
					},
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
