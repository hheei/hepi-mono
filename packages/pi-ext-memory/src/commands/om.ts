import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { splitSubcommand, subcommandCompletions } from "@hheei/pi-ext-core";
import type { Runtime } from "../runtime.js";
import { runCompactCommand } from "./compact.js";
import { runConsolidateCommand } from "./consolidate.js";
import { reportGateState, setGateEnabled } from "./gate.js";
import { runStatusCommand } from "./status.js";
import { runViewCommand, type ViewCommandOptions } from "./view.js";

/** Verbs of the dispatcher switch below; `"view full"` is `view`'s only argument. */
const OM_SUBCOMMANDS = ["on", "off", "status", "view", "consolidate", "compact"];
const USAGE = `Usage: /om ${OM_SUBCOMMANDS.join("|")}`;

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
		description: `om: /om [${OM_SUBCOMMANDS.join(" | ")}] (view takes "full")`,
		getArgumentCompletions: subcommandCompletions([...OM_SUBCOMMANDS, "view full"]),
		handler: async (args, ctx: ExtensionCommandContext): Promise<void> => {
			const { verb, rest } = splitSubcommand(typeof args === "string" ? args : "");

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
