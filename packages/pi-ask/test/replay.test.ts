import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatReplay, replayTui, stripAnsi, viewFrame } from "../../../scripts/tui-replay.js";
import { createAskComponent } from "../src/component.js";
import { normalizeAskParams } from "../src/model.js";

const theme = {
	fg: (color: string, text: string) => `\x1b[${color === "accent" ? 36 : 33}m${text}\x1b[0m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	dim: (text: string) => `\x1b[2m${text}\x1b[22m`,
	italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
	strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
} as unknown as Theme;

test("replays Ask with ANSI and plain frames", async () => {
	const done: unknown[] = [];
	const questionnaire = normalizeAskParams({
		questions: [
			{ id: "one", question: "First?", options: [{ label: "A" }, { label: "B" }] },
			{ id: "two", question: "Second?", options: [{ label: "C" }, { label: "D" }] },
		],
	});
	const result = await replayTui({
		columns: 48,
		rows: 24,
		create: (host) =>
			createAskComponent({
				questionnaire,
				host,
				theme,
				done: (value) => done.push(value),
			}),
		actions: [
			{ type: "key", key: "enter", label: "answer first" },
			{ type: "key", key: "enter", label: "answer second" },
			{ type: "key", key: "enter", label: "submit review" },
		],
	});

	expect(result.frames).toHaveLength(4);
	expect(stripAnsi(result.frames[1]?.lines.join("\n") ?? "")).toContain("Question #2");
	expect(stripAnsi(result.frames[2]?.lines.join("\n") ?? "")).toContain("Review");
	expect(result.frames[2]?.lines.join("\n") ?? "").toContain("\x1b[");
	const reviewFrame = result.frames[2];
	if (reviewFrame === undefined) throw new Error("Missing review frame");
	expect(viewFrame(reviewFrame).join("\n")).not.toContain("\x1b[");
	expect(formatReplay(result, { frames: "last" })).toContain("submit review");
	expect(done).toHaveLength(1);
	const submission = done[0];
	if (submission === null || typeof submission !== "object")
		throw new Error("Missing Ask submission");
	expect(Reflect.get(submission, "status")).toBe("submitted");
});
