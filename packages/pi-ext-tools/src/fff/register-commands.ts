import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { subcommandCompletions } from "@hheei/pi-ext-core";
import { buildStatusReport, FFF_RUNTIME_NOT_READY_TEXT } from "./extension-common.js";
import type { FffRuntime } from "./fff.js";

const USAGE = "Usage: /fff status|reindex";

export interface CommandRegistrationDeps {
	/** The command remains registered for the host lifetime; runtime availability is session-scoped. */
	getRuntime(): FffRuntime | null;
}

/**
 * Register `/fff`, the single command surface for the FFF file-search runtime.
 *
 * Subcommands rather than one top-level command per action: the host resolves a command by
 * its first word and hands the rest over as arguments, so both actions stay under one name
 * that autocompletes as one entry and shares a single description.
 */
export function registerCommands(pi: ExtensionAPI, deps: CommandRegistrationDeps): void {
	const requireSlashRuntime = (ctx: ExtensionContext): FffRuntime | null => {
		const runtime = deps.getRuntime();
		if (runtime) return runtime;
		ctx.ui.notify(FFF_RUNTIME_NOT_READY_TEXT, "warning");
		return null;
	};

	pi.registerCommand("fff", {
		description: "FFF file search runtime: /fff [status | reindex]",
		getArgumentCompletions: subcommandCompletions(["status", "reindex"]),
		handler: async (args, ctx) => {
			const verb = typeof args === "string" ? args.trim().toLowerCase() : "";

			if (verb === "reindex") {
				const runtime = requireSlashRuntime(ctx);
				if (!runtime) return;
				const result = await runtime.reindex();
				if (!result.ok) {
					ctx.ui.notify(`FFF reindex failed: ${result.error.message}`, "error");
					return;
				}
				ctx.ui.notify("FFF reindex started", "info");
				return;
			}

			if (verb === "status") {
				const runtime = requireSlashRuntime(ctx);
				if (!runtime) return;
				const statusResult = await runtime.getStatus();
				if (!statusResult.ok) {
					ctx.ui.notify(`fff status failed: ${statusResult.error.message}`, "error");
					return;
				}
				const metadata = await runtime.getMetadata();
				const healthResult = await runtime.healthCheck();
				ctx.ui.notify(
					buildStatusReport({
						status: statusResult.value,
						...(healthResult.ok ? { health: healthResult.value } : {}),
						metadata,
						healthError: !healthResult.ok ? healthResult.error : null,
					}),
					"info",
				);
				return;
			}

			ctx.ui.notify(`Unknown subcommand "${verb}". ${USAGE}`, "warning");
		},
	});
}
