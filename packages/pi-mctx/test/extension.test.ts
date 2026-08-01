import { expect, test } from "bun:test";
import piMctxExtension from "../src/extension.js";

test("pi-mctx entry registers only session lifecycle handlers", (): void => {
	const handlers: string[] = [];
	const tools: string[] = [];
	const pi = {
		events: {},
		on(name: string): void {
			handlers.push(name);
		},
		registerTool(tool: { readonly name: string }): void {
			tools.push(tool.name);
		},
	};

	piMctxExtension(pi as never);
	expect(handlers).toEqual(["session_start", "session_shutdown", "context", "turn_end"]);
	expect(tools).toEqual(["ctx_reduce", "ctx_expand", "ctx_memory", "ctx_note"]);
});
