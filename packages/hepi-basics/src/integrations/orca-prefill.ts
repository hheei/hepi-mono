import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHepiIntegration } from "./runtime.js";

export function registerOrcaPrefill(pi: ExtensionAPI): void {
	if (process.env.ORCA_PANE_KEY === undefined) return;

	registerHepiIntegration(pi, "orca-prefill", (isCurrent) => {
		pi.on("session_start", (event, ctx) => {
			if (!isCurrent() || event.reason !== "startup") return;
			const prefill = process.env.ORCA_PI_PREFILL;
			if (prefill === undefined || prefill.length === 0) return;
			delete process.env.ORCA_PI_PREFILL;
			ctx.ui.setEditorText(prefill);
		});
		return () => undefined;
	});
}
