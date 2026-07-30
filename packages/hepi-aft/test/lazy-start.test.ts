import { expect, mock, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

let startCalls = 0;

mock.module("../src/aft/runtime.js", () => ({
	HepiAftRuntime: class {
		async start(): Promise<void> {
			startCalls++;
		}

		async dispose(): Promise<void> {}
	},
}));

const { registerHepiAft } = await import("../src/extension.js");

type Handler = (event: { readonly toolName?: string }, ctx: ExtensionContext) => unknown;

test("starts AFT only when an AFT tool is about to execute", async () => {
	startCalls = 0;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		events: {},
		on(event: string, handler: Handler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		registerTool() {},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		sessionManager: { getSessionId: () => "lazy-start" },
	} as unknown as ExtensionContext;

	registerHepiAft(pi);
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	expect(startCalls).toBe(0);

	const toolCall = handlers.get("tool_call")?.[0];
	if (toolCall === undefined) throw new Error("Expected AFT tool_call handler");
	await Promise.all([
		toolCall({ toolName: "aft_outline" }, ctx),
		toolCall({ toolName: "aft_zoom" }, ctx),
	]);
	expect(startCalls).toBe(1);

	for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
});
