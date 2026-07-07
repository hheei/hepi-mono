import { describe, expect, it } from "bun:test";
import {
	applyPathShortcutExpansion,
	expandPathShortcut,
	PATH_SHORTCUT_TOOL_NAMES,
	pathShortcutSettingsFromState,
} from "../src/index.js";

describe("path shortcuts", () => {
	it("expands tmp URLs under the temp root", () => {
		expect(expandPathShortcut("tmp://logs/output.txt", undefined, { tmpRoot: "/tmp/pi" })).toEqual({
			changed: true,
			path: "/tmp/pi/logs/output.txt",
		});
	});

	it("leaves paths unchanged when disabled", () => {
		expect(
			expandPathShortcut(
				"tmp://logs/output.txt",
				{ enabled: false, tmpEnabled: true, enabledTools: PATH_SHORTCUT_TOOL_NAMES },
				{ tmpRoot: "/tmp/pi" },
			),
		).toEqual({ changed: false, path: "tmp://logs/output.txt" });
		expect(
			expandPathShortcut(
				"tmp://logs/output.txt",
				{ enabled: true, tmpEnabled: false, enabledTools: PATH_SHORTCUT_TOOL_NAMES },
				{ tmpRoot: "/tmp/pi" },
			),
		).toEqual({ changed: false, path: "tmp://logs/output.txt" });
	});

	it("blocks tmp path traversal", () => {
		expect(expandPathShortcut("tmp://../secret", undefined, { tmpRoot: "/tmp/pi" })).toEqual({
			error: "Path traversal is not allowed in tmp:// URLs: tmp://../secret",
		});
		expect(expandPathShortcut("tmp://%2E%2E/secret", undefined, { tmpRoot: "/tmp/pi" })).toEqual({
			error: "Path traversal is not allowed in tmp:// URLs: tmp://%2E%2E/secret",
		});
	});

	it("mutates tool path input", () => {
		const event = { toolName: "read", input: { path: "tmp://note.md" } };
		expect(applyPathShortcutExpansion(event, undefined, { tmpRoot: "/tmp/pi" })).toBeUndefined();
		expect(event.input.path).toBe("/tmp/pi/note.md");
	});

	it("does not mutate custom tool path input", () => {
		const event = { toolName: "custom_read", input: { path: "tmp://note.md" } };
		expect(applyPathShortcutExpansion(event, undefined, { tmpRoot: "/tmp/pi" })).toBeUndefined();
		expect(event.input.path).toBe("tmp://note.md");
	});

	it("derives settings from state", () => {
		expect(pathShortcutSettingsFromState(undefined)).toEqual({
			enabled: true,
			tmpEnabled: true,
			enabledTools: [...PATH_SHORTCUT_TOOL_NAMES],
		});
		expect(
			pathShortcutSettingsFromState({ pathShortcuts: { enabled: false, tmpEnabled: false } }),
		).toEqual({ enabled: false, tmpEnabled: false, enabledTools: [...PATH_SHORTCUT_TOOL_NAMES] });
	});
});
