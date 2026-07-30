import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerHepiIntegration } from "./runtime.js";

function baseTitle(pi: ExtensionAPI): string {
	const session = pi.getSessionName();
	return session === undefined ? "\u03c0" : `\u03c0\u00b7${session}`;
}

export function registerOrcaTitlebarSpinner(pi: ExtensionAPI): void {
	if (process.env.ORCA_PANE_KEY === undefined) return;
	registerHepiIntegration(pi, "orca-titlebar-spinner", (isCurrent) => {
		const setTitle = (ctx: ExtensionContext): void => {
			ctx.ui.setTitle(baseTitle(pi));
		};

		pi.on("session_info_changed", (_event, ctx) => {
			if (isCurrent()) setTitle(ctx);
		});
		pi.on("session_start", (_event, ctx) => {
			if (isCurrent()) setTitle(ctx);
		});
		return () => undefined;
	});
}
