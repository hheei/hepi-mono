import { expect, test } from "bun:test";
import { renderMctxToolOutput } from "../src/tool-output.js";

test("MCTX tool output has a stable status header for success and errors", (): void => {
	expect(
		renderMctxToolOutput({ body: "Queued drops: #4.", dropped: [2, 1, 2], pending: [4] }),
	).toEqual({
		content: [
			{ type: "text", text: "[magic context]\ndropped: #1, #2\npending: #4\n\nQueued drops: #4." },
		],
		details: undefined,
	});
	expect(renderMctxToolOutput({ body: "Context changed.", isError: true })).toEqual({
		content: [
			{ type: "text", text: "[magic context]\ndropped: none\npending: none\n\nContext changed." },
		],
		details: undefined,
		isError: true,
	});
});
