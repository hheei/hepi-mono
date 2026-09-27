import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { subcommandCompletions } from "@hheei/pi-ext-core";
import type { Runtime } from "../runtime.js";
import { runCompactCommand } from "./compact.js";
import { runConsolidateCommand } from "./consolidate.js";
import { reportGateState, setGateEnabled } from "./gate.js";
import { runStatusCommand } from "./status.js";
import { runViewCommand, type ViewCommandOptions } from "./view.js";

const USAGE = "Usage: /om on|off|status|view|consolidate|compact";

/** Same set as the description and the dispatcher switch; used for argument completion. */
const OM_SUBCOMMANDS = ["on", "off", "status", "view", "consolidate", "compact"];

export interface OmCommandOptions {
	readonly view?: ViewCommandOptions;
}

/**
 * Register `/om`, the single command surface for observational memory.
 *
 * Subcommands rather than one top-level command per action: the host resolves a command by
 * its first word and hands the rest over as arguments, so `/om <verb>` keeps the whole
 * family under one name that autocompletes, documents itself in a single description, and
 * cannot collide with a Pi built-in such as `/compact`.
 */
export function registerOmCommand(
	pi: ExtensionAPI,
	runtime: Runtime,
	options: OmCommandOptions = {},
): void {
	pi.registerCommand("om", {
		description:
			"Observational memory: /om [on | off | status | view [full] | consolidate | compact]",
		getArgumentCompletions: subcommandCompletions(OM_SUBCOMMANDS, { args: { view: ["full"] } }),
		handler: async (args, ctx: ExtensionCommandContext): Promise<void> => {
			const input = typeof args === "string" ? args.trim() : "";
			const separator = input.search(/\s/u);
			const verb = (separator < 0 ? input : input.slice(0, separator)).toLowerCase();
			const rest = separator < 0 ? "" : input.slice(separator).trim();

			switch (verb) {
				case "":
					reportGateState(ctx);
					return;
				case "on":
				case "off":
					// No arguments: a stray word would otherwise be silently ignored.
					if (rest !== "") break;
					setGateEnabled(pi, verb === "on", ctx);
					return;
				case "status":
					await runStatusCommand(runtime, ctx);
					return;
				case "view":
					await runViewCommand(runtime, ctx, rest, options.view);
					return;
				case "consolidate":
					await runConsolidateCommand(pi, runtime, ctx);
					return;
				case "compact":
					await runCompactCommand(runtime, ctx);
					return;
				default:
					break;
			}

			ctx.ui.notify(`Unknown subcommand "${verb}". ${USAGE}`, "info");
		},
	});
}
