import { expect, test } from "bun:test";
import { renderMctxToolOutput } from "../src/tool-output.js";

test("MCTX tool output adds provenance without unrelated queue state", (): void => {
	expect(renderMctxToolOutput({ body: "pending: #4\nrejected: none" })).toEqual({
		content: [{ type: "text", text: "[magic context]\npending: #4\nrejected: none" }],
		details: undefined,
	});
	expect(renderMctxToolOutput({ body: "Context changed.", isError: true })).toEqual({
		content: [{ type: "text", text: "[magic context]\nContext changed." }],
		details: undefined,
		isError: true,
	});
});
