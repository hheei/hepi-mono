import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildStatusReport, FFF_RUNTIME_NOT_READY_TEXT } from "./extension-common.js";
import type { FffRuntime } from "./fff.js";

export interface CommandRegistrationDeps {
	getRuntime(): FffRuntime | null;
}

export function registerCommands(pi: ExtensionAPI, deps: CommandRegistrationDeps): void {
	const requireSlashRuntime = (ctx: ExtensionContext): FffRuntime | null => {
		const runtime = deps.getRuntime();
		if (runtime) return runtime;
		ctx.ui.notify(FFF_RUNTIME_NOT_READY_TEXT, "warning");
		return null;
	};

	pi.registerCommand("reindex-fff", {
		description: "Trigger an fff rescan for the current project",
		handler: async (_args, ctx) => {
			const runtime = requireSlashRuntime(ctx);
			if (!runtime) return;
			const result = await runtime.reindex();
			if (result.isErr()) {
				ctx.ui.notify(`FFF reindex failed: ${result.error.message}`, "error");
				return;
			}
			ctx.ui.notify("FFF reindex started", "info");
		},
	});

	pi.registerCommand("fff-status", {
		description: "Show fff runtime status and index health",
		handler: async (_args, ctx) => {
			const runtime = requireSlashRuntime(ctx);
			if (!runtime) return;
			const statusResult = await runtime.getStatus();
			if (statusResult.isErr()) {
				ctx.ui.notify(`fff status failed: ${statusResult.error.message}`, "error");
				return;
			}
			const metadata = await runtime.getMetadata();
			const healthResult = await runtime.healthCheck();
			ctx.ui.notify(
				buildStatusReport({
					status: statusResult.value,
					...(healthResult.isOk() ? { health: healthResult.value } : {}),
					metadata,
					healthError: healthResult.isErr() ? healthResult.error : null,
				}),
				"info",
			);
		},
	});
}
