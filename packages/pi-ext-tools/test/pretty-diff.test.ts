import { describe, expect, test } from "bun:test";
import { getEditOperations } from "../src/edit.js";
import { parseDiff } from "../src/pretty/diff.js";
import { lang } from "../src/pretty/lang.js";
import { LinesBody } from "../src/pretty/lines-body.js";

describe("LinesBody", () => {
	test("reuses rows until width changes", (): void => {
		let paints = 0;
		const body = new LinesBody((width) => {
			paints += 1;
			return [`width ${width}`];
		});
		expect(body.render(80)).toEqual(["width 80"]);
		expect(body.render(80)).toEqual(["width 80"]);
		expect(body.render(40)).toEqual(["width 40"]);
		expect(paints).toBe(2);
	});
});

describe("parseDiff", () => {
	test("counts added and removed lines", (): void => {
		const parsed = parseDiff("alpha\nbeta\n", "alpha\ngamma\n");
		expect(parsed.added).toBe(1);
		expect(parsed.removed).toBe(1);
		expect(parsed.lines.some((line) => line.type === "del" && line.content === "beta")).toBe(true);
		expect(parsed.lines.some((line) => line.type === "add" && line.content === "gamma")).toBe(true);
	});

	test("ignores CRLF-only differences", (): void => {
		const parsed = parseDiff("alpha\r\nbeta\r\n", "alpha\nbeta\n");
		expect(parsed.added).toBe(0);
		expect(parsed.removed).toBe(0);
	});
});

describe("getEditOperations", () => {
	test("accepts snake_case aliases", (): void => {
		expect(
			getEditOperations({
				path: "a.ts",
				edits: [{ old_text: "before", new_text: "after" }],
			} as never),
		).toEqual([{ oldText: "before", newText: "after" }]);
	});
});

describe("lang", () => {
	test("maps common extensions and special filenames", (): void => {
		expect(lang("src/app.ts")).toBe("typescript");
		expect(lang("Dockerfile")).toBe("dockerfile");
		expect(lang("unknown.bin")).toBeUndefined();
	});
});
