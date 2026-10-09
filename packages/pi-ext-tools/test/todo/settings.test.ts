import { describe, expect, it } from "vitest";
import {
	createTodoSettingsProvider,
	DEFAULT_TODO_ENABLED,
	readTodoSettings,
} from "../../src/todo/settings.js";

describe("todo settings", () => {
	it("defaults todo to disabled", () => {
		expect(DEFAULT_TODO_ENABLED).toBe(false);
	});

	it("reads disabled state by default from non-existent settings", () => {
		const settings = readTodoSettings("/non/existent/path/ext_settings.json");
		expect(settings.enabled).toBe(false);
	});

	it("creates settings provider with todo group and disabled default", () => {
		const provider = createTodoSettingsProvider();
		expect(provider.id).toBe("pi-ext-tools.todo");
		expect(provider.groups[0]?.id).toBe("todo");
		const field = provider.groups[0]?.fields.find((f) => f.id === "enabled");
		expect(field).toBeDefined();
		expect(field?.defaultValue).toBe(false);
	});
});
