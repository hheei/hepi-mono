import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { saveRtkConfig } from "./config.js";
import type { RtkFeature } from "./feature.js";
import { DEFAULT_RTK_INTEGRATION_CONFIG } from "./types.js";
export function registerRtkCommand(pi: ExtensionAPI, feature: RtkFeature): void {
	pi.registerCommand("rtk", {
		description: "RTK status and output compaction",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command || command === "help") {
				ctx.ui.notify(
					"Use /hepi setting to configure RTK; /rtk show|verify|stats|clear-stats|reset|path",
					"info",
				);
				return;
			}
			if (command === "show" || command === "verify") {
				const status = await feature.refresh(true);
				ctx.ui.notify(
					`RTK: ${status.rtkAvailable ? "available" : "missing"}${status.rtkExecutablePath ? ` (${status.rtkExecutablePath})` : ""}`,
					status.rtkAvailable ? "info" : "warning",
				);
				return;
			}
			if (command === "stats") {
				ctx.ui.notify(feature.metrics(), "info");
				return;
			}
			if (command === "clear-stats") {
				feature.clearMetrics();
				ctx.ui.notify("RTK metrics cleared", "info");
				return;
			}
			if (command === "reset") {
				feature.setConfig(DEFAULT_RTK_INTEGRATION_CONFIG);
				await saveRtkConfig(ctx.cwd ?? process.cwd(), DEFAULT_RTK_INTEGRATION_CONFIG);
				ctx.ui.notify("RTK settings reset", "info");
				return;
			}
			if (command === "path") {
				ctx.ui.notify(`${ctx.cwd ?? process.cwd()}/.pi/settings.json`, "info");
				return;
			}
			ctx.ui.notify(`Unknown /rtk command: ${command}`, "error");
		},
	});
}
