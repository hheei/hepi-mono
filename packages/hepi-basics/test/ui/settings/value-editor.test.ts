import { describe, expect, test } from "bun:test";
import { ValueEditor } from "../../../src/core/ui/settings/value-editor.js";
import { visibleWidth } from "../../../src/core/ui/text.js";

describe("value editor", () => {
	test("uses Pi input editing", () => {
		const editor = new ValueEditor("abc");
		editor.handleInput("\x1b[H");
		editor.handleInput("X");
		editor.handleInput("\x1b[C");
		editor.handleInput("\x7f");
		expect(editor.text).toBe("Xbc");
	});
	test("renders a cell-safe input viewport", () => {
		const editor = new ValueEditor("0123456789");
		expect(visibleWidth(editor.render(4))).toBeLessThanOrEqual(4);
	});
	test("accepts bracketed paste through Pi input", () => {
		const editor = new ValueEditor("界e\u0301\tZ");
		editor.handleInput("\x1b[200~ pasted \x1b[201~");
		expect(editor.text).toBe("界e\u0301\tZ pasted ");
	});
});
