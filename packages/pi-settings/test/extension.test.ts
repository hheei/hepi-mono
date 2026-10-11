import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import piSettingsExtension from "../src/extension.js";

type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;

test("registers /ext-settings only and rejects unavailable command contexts", async () => {
	const commands = new Map<string, CommandHandler>();
	const pi = {
		events: {},
		on: () => undefined,
		registerCommand: (commandName: string, definition: { readonly handler: CommandHandler }) => {
			commands.set(commandName, definition.handler);
		},
	} as unknown as ExtensionAPI;
	piSettingsExtension(pi);
	expect([...commands.keys()]).toEqual(["ext-settings"]);
	const settings = commands.get("ext-settings");
	expect(settings).toBeDefined();

	const notices: Array<{ readonly message: string; readonly level?: string }> = [];
	const notify = (message: string, level?: string): void => {
		notices.push(level === undefined ? { message } : { message, level });
	};
	await settings?.("settings", {
		mode: "print",
		ui: { notify },
	} as unknown as ExtensionCommandContext);
	await settings?.("settings", {
		mode: "tui",
		ui: { notify },
	} as unknown as ExtensionCommandContext);
	await settings?.("", { mode: "tui", ui: { notify } } as unknown as ExtensionCommandContext);
	expect(notices).toEqual([
		{ message: "/ext-settings requires TUI mode.", level: "warning" },
		{ message: "Settings are not active for this session.", level: "warning" },
		{ message: "Settings are not active for this session.", level: "warning" },
	]);
});
