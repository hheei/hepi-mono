import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { HepiModule, HepiModuleRegistry } from "../api/modules.js";
import type { HepiCommandContext } from "../api/settings.js";
import type { HepiCommandRoute, ParsedHepiCommand } from "./command-types.js";

const registeredApis = new WeakSet<object>();

function commandCompletions(
	registry: HepiModuleRegistry,
	prefix: string,
): AutocompleteItem[] | null {
	const normalized = prefix.trim().toLowerCase();
	const items = new Map<string, AutocompleteItem>();
	for (const module of registry.list()) {
		for (const command of module.commands) {
			if (!items.has(command)) {
				const description =
					command === "setting"
						? "Open HEPI Settings"
						: command === "loadout"
							? "Open HEPI Loadout"
							: `Open ${module.label}`;
				items.set(command, { value: command, label: command, description });
			}
		}
	}
	const matches = [...items.values()].filter((item) =>
		item.value.toLowerCase().startsWith(normalized),
	);
	return matches.length > 0 ? matches : null;
}

interface CommandContext {
	readonly mode: string;
	readonly ui: {
		notify(message: string, level?: string): void;
	};
	readonly sessionManager: {
		getSessionId(): string;
	};
}

export function parseHepiCommand(rawArgs: string): ParsedHepiCommand {
	const input = rawArgs.trim();
	if (!input) return { subcommand: "", args: "" };
	const separator = input.search(/\s/);
	if (separator === -1) return { subcommand: input, args: "" };
	return {
		subcommand: input.slice(0, separator),
		args: input.slice(separator).trim(),
	};
}

export function routeHepiCommand(
	rawArgs: string,
	registry: HepiModuleRegistry,
): HepiCommandRoute | undefined {
	const parsed = parseHepiCommand(rawArgs);
	if (!parsed.subcommand) return undefined;
	const matches = registry.list().filter((module) => module.commands.includes(parsed.subcommand));
	if (matches.length !== 1) return undefined;
	return { module: matches[0] as HepiModule, args: parsed.args };
}

async function openHepiModule(
	module: HepiModule,
	args: string,
	command: string,
	ctx: CommandContext,
): Promise<void> {
	// Keep Pi's guarded context getters lazy across module-owned async UI work.
	const moduleContext = Object.create(ctx, {
		command: { value: command, enumerable: true },
		sessionId: { value: ctx.sessionManager.getSessionId(), enumerable: true },
	}) as HepiCommandContext;
	await module.open(args, moduleContext);
}

export async function dispatchHepiCommand(
	rawArgs: string,
	ctx: CommandContext,
	registry: HepiModuleRegistry,
): Promise<void> {
	const parsed = parseHepiCommand(rawArgs);
	if (!parsed.subcommand) {
		ctx.ui.notify("Usage: /hepi <subcommand> [args]", "info");
		return;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`/hepi ${parsed.subcommand} requires TUI mode`, "error");
		return;
	}

	const matches = registry.list().filter((module) => module.commands.includes(parsed.subcommand));
	if (matches.length === 0) {
		ctx.ui.notify(`Unknown /hepi subcommand: ${parsed.subcommand}`, "error");
		return;
	}
	if (matches.length > 1) {
		ctx.ui.notify(`Multiple modules handle /hepi ${parsed.subcommand}`, "error");
		return;
	}

	await openHepiModule(matches[0] as HepiModule, parsed.args, parsed.subcommand, ctx);
}

export function registerHepiCommand(pi: ExtensionAPI, registry: HepiModuleRegistry): void {
	if (registeredApis.has(pi)) return;
	pi.registerCommand("ext-settings", {
		description: "Open extension settings",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/ext-settings requires TUI mode", "error");
				return;
			}
			const settingsModule = registry.get("setting");
			if (settingsModule === undefined) {
				ctx.ui.notify("Extension settings are unavailable", "error");
				return;
			}
			await openHepiModule(settingsModule, "", "setting", ctx);
		},
	});
	pi.registerCommand("loadout", {
		description: "Open HEPI Loadout",
		handler: async (_args, ctx) => {
			await dispatchHepiCommand("loadout", ctx, registry);
		},
	});
	pi.registerCommand("hepi", {
		description: "Open a HEPI module",
		getArgumentCompletions: (prefix) => commandCompletions(registry, prefix),
		handler: async (args, ctx) => {
			await dispatchHepiCommand(args, ctx, registry);
		},
	});
	registeredApis.add(pi);
}
