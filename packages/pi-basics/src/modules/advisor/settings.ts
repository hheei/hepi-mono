import type { HePiSettingsProvider, HePiSettingValue } from "../../api/settings.js";
import { createAutoTitleStorage } from "../auto-title/index.js";
import { parseModelRef, parseThinking } from "./model.js";
export function createAdvisorSettingsProvider(options: {
	readonly path: string;
	readonly validatePersisted?: (
		model: string | undefined,
		thinking: string,
	) => void | Promise<void>;
	readonly onPersisted?: (model: string | undefined, thinking: string) => void | Promise<void>;
}): HePiSettingsProvider {
	const storage = createAutoTitleStorage({ path: options.path, group: "advisor" });
	return {
		id: "pi-basics-advisor",
		title: "Advisor",
		origin: "@hheei/pi-basics",
		description: "Read-only turn review.",
		groups: [
			{
				id: "advisor",
				title: "Advisor",
				fields: [
					{
						id: "model",
						label: "Model",
						type: "text",
						defaultValue: "",
						parse: (value) => value.trim(),
						validate: (value) =>
							typeof value === "string" && value.length > 0 && !parseModelRef(value)
								? "Use provider/model"
								: undefined,
					},
					{
						id: "thinking",
						label: "Thinking",
						type: "enum",
						defaultValue: "medium",
						options: ["off", "minimal", "low", "medium", "high", "xhigh"].map((value) => ({
							value,
							label: value,
						})),
						parse: (value) => value,
						validate: (value) => (parseThinking(value) ? undefined : "Invalid thinking level"),
					},
				],
			},
		],
		storage: {
			async load(ctx) {
				const state = await storage.load(ctx);
				return state?.advisor ? { advisor: state.advisor } : undefined;
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
