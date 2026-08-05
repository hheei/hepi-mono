import { createJsonSectionSettingsStorage, type HepiSettingsProvider } from "@hheei/pi-ext-core";

export const DEBUG_SETTINGS_SECTION = "pi-debug";
export const DEBUG_SETTINGS_GROUP = "cache";
export const DEBUG_ENABLED_FIELD = "enabled";

export function createDebugSettingsProvider(
	onEnabledChange: (sessionId: string, enabled: boolean) => void,
): HepiSettingsProvider {
	return {
		id: DEBUG_SETTINGS_SECTION,
		title: "Pi Debug",
		origin: "@hheei/pi-debug",
		groups: [
			{
				id: DEBUG_SETTINGS_GROUP,
				title: "",
				fields: [
					{
						id: DEBUG_ENABLED_FIELD,
						label: "cache diagnostics",
						type: "boolean",
						defaultValue: false,
						description: "Write hash-only provider payload diagnostics for prompt-cache analysis.",
						parse: (draft) => {
							if (draft === "true") return true;
							if (draft === "false") return false;
							throw new Error("Expected true or false");
						},
					},
				],
			},
		],
		storage: createJsonSectionSettingsStorage({
			section: DEBUG_SETTINGS_SECTION,
			group: DEBUG_SETTINGS_GROUP,
		}),
		onLoad: (state, context) => {
			onEnabledChange(
				context.sessionId,
				state[DEBUG_SETTINGS_GROUP]?.[DEBUG_ENABLED_FIELD] === true,
			);
		},
		onChange: (change, context) => {
			if (change.groupId !== DEBUG_SETTINGS_GROUP || change.fieldId !== DEBUG_ENABLED_FIELD) return;
			onEnabledChange(context.sessionId, change.value === true);
		},
	};
}
