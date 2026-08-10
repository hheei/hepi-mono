import { describe, expect, test } from "bun:test";
import piExtToolsExtension from "../src/extension.js";

type ToolResultHandler = (event: { toolName: string; details: unknown }) => unknown;

function toolResultHandler(): ToolResultHandler {
	const handlers = new Map<string, ToolResultHandler>();
	piExtToolsExtension(
		new Proxy(
			{ events: {} },
			{
				get: (_target, property) => {
					if (property === "on") {
						return (event: string, handler: ToolResultHandler) => handlers.set(event, handler);
					}
					return () => undefined;
				},
			},
		) as never,
	);
	const handler = handlers.get("tool_result");
	if (handler === undefined) throw new Error("Expected tool_result handler");
	return handler;
}

describe("apply_patch tool_result contract", () => {
	test("marks only partial and failed actual outcomes as Pi errors", () => {
		const handler = toolResultHandler();
		expect(handler({ toolName: "apply_patch", details: { status: "success" } })).toBeUndefined();
		expect(handler({ toolName: "apply_patch", details: { status: "partial" } })).toEqual({
			isError: true,
		});
		expect(handler({ toolName: "apply_patch", details: { status: "failed" } })).toEqual({
			isError: true,
		});
		expect(handler({ toolName: "read", details: { status: "partial" } })).toBeUndefined();
	});
});
