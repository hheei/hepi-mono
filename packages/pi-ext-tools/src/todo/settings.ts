import { createJsonSettingsStorage, type SettingsProvider } from "@hheei/pi-ext-core";
import { readGlobalSettingsGroup } from "../global-settings.js";

const GROUP = "todo";

export const DEFAULT_TODO_ENABLED = false;

export interface TodoSettingsProviderOptions {
	readonly path?: string;
}

export function readTodoSettings(path?: string): {
	readonly enabled: boolean;
} {
	const fields = readGlobalSettingsGroup(GROUP, path);
	return {
		enabled: fields?.enabled === true,
	};
}

export function createTodoSettingsProvider(
	options: TodoSettingsProviderOptions = {},
): SettingsProvider {
	return {
		id: "pi-ext-tools.todo",
		title: "Todo",
		origin: "@hheei/pi-ext-tools",
		description: "Todo list and task tracking tool. Disabled by default.",
		groups: [
			{
				id: GROUP,
				title: "",
				fields: [
					{
						id: "enabled",
						label: "Enable Todo Tool",
						type: "boolean",
						defaultValue: DEFAULT_TODO_ENABLED,
						description: "Enable the todo tool for tracking multi-step tasks. Disabled by default.",
						parse: (value) => value === "true",
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
