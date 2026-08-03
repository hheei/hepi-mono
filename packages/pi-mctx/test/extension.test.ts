import { expect, test } from "bun:test";
import { observeLoadoutInventory } from "@hheei/pi-ext-core";
import piMctxExtension from "../src/extension.js";

test("pi-mctx entry registers lifecycle handlers and managed Magic Context tools", (): void => {
	const handlers: string[] = [];
	const tools: string[] = [];
	const commands: string[] = [];
	const pi = {
		events: {},
		on(name: string): void {
			handlers.push(name);
		},
		registerTool(tool: { readonly name: string }): void {
			tools.push(tool.name);
		},
		registerCommand(name: string): void {
			commands.push(name);
		},
	};
	const controller = new AbortController();
	const inventories: string[][] = [];
	observeLoadoutInventory(pi as never, {
		signal: controller.signal,
		onChange(items) {
			inventories.push(items.map((item) => `${item.id}:${item.group}`));
		},
	});

	piMctxExtension(pi as never);
	expect(handlers).toEqual(["session_start", "session_shutdown", "context", "turn_end"]);
	expect(tools).toEqual([
		"ctx_reduce",
		"ctx_expand",
		"ctx_history",
		"ctx_search",
		"ctx_memory",
		"ctx_note",
	]);
	expect(commands).toEqual(["ctx-aug", "ctx-dream", "ctx-embed"]);
	expect(inventories.at(-1)).toEqual([
		"ctx_expand:Magic Context",
		"ctx_history:Magic Context",
		"ctx_memory:Magic Context",
		"ctx_note:Magic Context",
		"ctx_reduce:Magic Context",
		"ctx_search:Magic Context",
	]);
	controller.abort();
});
