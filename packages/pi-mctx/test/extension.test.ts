import { expect, test } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { observeLoadoutInventory } from "@hheei/pi-ext-core";
import piMctxExtension from "../src/extension.js";

interface TestCommand {
	readonly description?: string;
	readonly getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
	readonly handler: (args: string, context: ExtensionCommandContext) => Promise<void>;
}

test("pi-mctx entry registers lifecycle handlers and managed Magic Context tools", (): void => {
	const handlers: string[] = [];
	const tools: string[] = [];
	const commands = new Map<string, TestCommand>();
	const pi = {
		events: {},
		on(name: string): void {
			handlers.push(name);
		},
		registerTool(tool: { readonly name: string }): void {
			tools.push(tool.name);
		},
		registerCommand(name: string, command: TestCommand): void {
			commands.set(name, command);
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
	expect(tools).toEqual(["ctx_reduce", "ctx_expand", "ctx_history"]);
	expect([...commands.keys()]).toEqual(["mctx"]);
	const complete = commands.get("mctx")?.getArgumentCompletions;
	expect(complete?.("")).toEqual([
		{
			value: "status",
			label: "status",
			description: "Show read-only Magic Context status",
		},
		{
			value: "flush",
			label: "flush",
			description: "Apply queued context tag drops",
		},
		{
			value: "recomp",
			label: "recomp",
			description: "Rebuild compartments from the current session branch",
		},
		{
			value: "wrapup",
			label: "wrapup",
			description: "Compact older turns while retaining recent messages",
		},
		{
			value: "dream",
			label: "dream",
			description: "Run a bounded smart-note evaluation",
		},
		{
			value: "aug",
			label: "aug",
			description: "Run a read-only Sidekick and inject its result once",
		},
	]);
	expect(complete?.("st")?.map((item) => item.value)).toEqual(["status"]);
	expect(complete?.("a")?.map((item) => item.value)).toEqual(["aug"]);
	expect(complete?.("wrapup ")).toEqual([
		{
			value: "wrapup 2",
			label: "wrapup 2",
			description: "Retain at least 2 recent messages",
		},
		{
			value: "wrapup 4",
			label: "wrapup 4",
			description: "Retain at least 4 recent messages",
		},
		{
			value: "wrapup 8",
			label: "wrapup 8",
			description: "Retain at least 8 recent messages",
		},
		{
			value: "wrapup 16",
			label: "wrapup 16",
			description: "Retain at least 16 recent messages",
		},
	]);
	expect(complete?.("aug ")).toBeNull();
	expect(complete?.("missing")).toBeNull();
	// MCTX tools have static Pi definitions but only publish inventory after runtime admission.
	expect(inventories.at(-1)).toEqual([]);
	controller.abort();
});

test("mctx routes active subcommands and rejects invalid arguments", async (): Promise<void> => {
	let command: TestCommand | undefined;
	const pi = {
		events: {},
		on(): void {},
		registerTool(): void {},
		registerCommand(_name: string, registered: TestCommand): void {
			command = registered;
		},
	};
	piMctxExtension(pi as never);
	if (command === undefined) throw new Error("mctx command was not registered");

	const notifications: Array<{ readonly message: string; readonly level?: string }> = [];
	const context = {
		mode: "tui",
		ui: {
			notify(message: string, level?: string): void {
				notifications.push({ message, ...(level === undefined ? {} : { level }) });
			},
		},
	} as unknown as ExtensionCommandContext;

	await command.handler("", context);
	await command.handler("status", context);
	await command.handler("status extra", context);
	await command.handler("flush", context);
	await command.handler("recomp", context);
	await command.handler("wrapup", context);
	await command.handler("wrapup 0", context);
	await command.handler("dream", context);
	await command.handler("aug", context);
	await command.handler("aug inspect the repository", context);
	await command.handler("missing", context);

	expect(notifications).toEqual([
		{ message: "pi-mctx lifecycle is not active", level: "warning" },
		{ message: "pi-mctx lifecycle is not active", level: "warning" },
		{ message: "Usage: /mctx status", level: "error" },
		{ message: "pi-mctx is not active for this session.", level: "error" },
		{ message: "pi-mctx is not active for this session.", level: "error" },
		{ message: "pi-mctx is not active for this session.", level: "error" },
		{ message: "Usage: /mctx wrapup [positive messages_to_keep]", level: "error" },
		{ message: "pi-mctx is not active for this session.", level: "error" },
		{ message: "Usage: /mctx aug <query up to 500 characters>", level: "error" },
		{ message: "pi-mctx is not active for this session.", level: "error" },
		{
			message:
				"Unknown MCTX subcommand: missing. Usage: /mctx [status | flush | recomp | wrapup [messages_to_keep] | dream [query] | aug <query>]",
			level: "error",
		},
	]);

	notifications.length = 0;
	const jsonContext = { ...context, mode: "json" } as unknown as ExtensionCommandContext;
	await command.handler("aug", jsonContext);
	await command.handler(`aug ${"x".repeat(501)}`, jsonContext);
	await command.handler("aug inspect the repository", jsonContext);
	expect(notifications).toEqual([
		{ message: "Usage: /mctx aug <query up to 500 characters>", level: "error" },
		{ message: "Usage: /mctx aug <query up to 500 characters>", level: "error" },
		{ message: "/mctx aug requires interactive mode", level: "error" },
	]);
});
