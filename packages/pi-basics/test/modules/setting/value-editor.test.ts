import { describe, expect, test } from "bun:test";
import { ValueEditor } from "../../../src/modules/setting/value-editor.js";
import { visibleWidth } from "../../../src/ui/text.js";

describe("value editor", () => {
	test("edits text and tracks cursor", () => {
		const editor = new ValueEditor("abc");
		editor.home();
		editor.insert("X");
		editor.move(1);
		editor.backspace();
		expect(editor.text).toBe("Xbc");
		expect(editor.cursor).toBe(1);
	});
	test("keeps visible viewport near cursor", () => {
		const editor = new ValueEditor("0123456789");
		editor.end();
		expect(editor.visible(4)).toBe("6789");
		expect(editor.viewport).toBe(6);
	});
	test("keeps wide, combining, and tab text cell-safe while moving by grapheme", () => {
		const editor = new ValueEditor("界e\u0301\tZ");
		editor.home();
		editor.move(1);
		expect(editor.cursor).toBe("界".length);
		editor.move(1);
		expect(editor.cursor).toBe("界e\u0301".length);
		expect(visibleWidth(editor.visible(3))).toBeLessThanOrEqual(3);
		editor.backspace();
		expect(editor.text).toBe("界\tZ");
		editor.delete();
		expect(editor.text).toBe("界Z");
	});
});
