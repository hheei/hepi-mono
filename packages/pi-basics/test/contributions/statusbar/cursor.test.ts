import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createCursorSettingsProvider,
	cursorEscape,
	cursorOptionsFromState,
	DEFAULT_CURSOR_OPTIONS,
} from "../../../src/contributions/statusbar/cursor.js";

const context = { sessionId: "test", cwd: "/tmp" };

describe("cursor settings", () => {
	test("defaults to a steady block", () => {
		expect(DEFAULT_CURSOR_OPTIONS).toEqual({ shape: "block", blink: false });
		expect(cursorOptionsFromState(undefined)).toEqual({ shape: "block", blink: false });
	});

	test("maps every shape and blink state to DECSCUSR", () => {
		expect(cursorEscape({ shape: "bar", blink: true })).toBe("\x1b[5 q");
		expect(cursorEscape({ shape: "bar", blink: false })).toBe("\x1b[6 q");
		expect(cursorEscape({ shape: "block", blink: true })).toBe("\x1b[1 q");
		expect(cursorEscape({ shape: "block", blink: false })).toBe("\x1b[2 q");
		expect(cursorEscape({ shape: "underline", blink: true })).toBe("\x1b[3 q");
		expect(cursorEscape({ shape: "underline", blink: false })).toBe("\x1b[4 q");
		expect(cursorEscape({ shape: "hollow", blink: true })).toBe("\x1b[1 q\x1b[7 q");
		expect(cursorEscape({ shape: "hollow", blink: false })).toBe("\x1b[2 q\x1b[8 q");
	});

	test("persists normalized cursor options and notifies the runtime", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-basics-cursor-"));
		const path = join(directory, "settings.json");
		let persisted = DEFAULT_CURSOR_OPTIONS;
		const provider = createCursorSettingsProvider({
			path,
			onPersisted: (options) => {
				persisted = options;
			},
		});
		await provider.storage.save({ cursor: { shape: "underline", blink: true } }, context);
		expect(persisted).toEqual({ shape: "underline", blink: true });
		expect(await readFile(path, "utf8")).toContain(
			'"cursor": {\n      "shape": "underline",\n      "blink": true',
		);
	});
});
