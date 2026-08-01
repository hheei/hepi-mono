import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import piLoadoutExtension from "../src/extension.js";

type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;

test("registers /loadout and rejects unavailable command contexts", async () => {
	let name: string | undefined;
	let handler: CommandHandler | undefined;
	const pi = {
		events: {},
		on: () => undefined,
		registerCommand: (commandName: string, definition: { readonly handler: CommandHandler }) => {
			name = commandName;
			handler = definition.handler;
		},
	} as unknown as ExtensionAPI;
	piLoadoutExtension(pi);
	expect(name).toBe("loadout");
	expect(handler).toBeDefined();

	const notices: Array<{ readonly message: string; readonly level?: string }> = [];
	const notify = (message: string, level?: string): void => {
		notices.push(level === undefined ? { message } : { message, level });
	};
	await handler?.("", { mode: "print", ui: { notify } } as unknown as ExtensionCommandContext);
	await handler?.("", { mode: "tui", ui: { notify } } as unknown as ExtensionCommandContext);
	expect(notices).toEqual([
		{ message: "/loadout requires TUI mode.", level: "warning" },
		{ message: "Loadout is not active for this session.", level: "warning" },
	]);
});
