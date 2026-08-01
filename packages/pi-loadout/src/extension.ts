import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	openExtensionPageRouter,
	registerExtensionLifecycle,
	registerExtensionPage,
	suspendHepiWidgets,
} from "@hheei/pi-ext-core";
import { createLoadoutEngine } from "./engine.js";
import { createLoadoutPage } from "./page.js";

interface ActiveLoadoutSession {
	readonly signal: AbortSignal;
}

export default function piLoadoutExtension(pi: ExtensionAPI): void {
	// The command starts on Loadout but uses the shared router. This keeps page rendering
	// and widget suspension identical to /ext-settings without importing pi-settings.
	let active: ActiveLoadoutSession | undefined;
	const engine = createLoadoutEngine(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-loadout",
		start: async ({ extension, signal, resources }) => {
			const session: ActiveLoadoutSession = { signal };
			active = session;
			resources.add("loadout-session", () => {
				if (active === session) active = undefined;
			});
			await engine.start(extension, signal);
			resources.add("loadout-engine", () => engine.dispose());
			registerExtensionPage(
				{ pi, extension, signal, resources },
				{
					id: "loadout",
					label: "Loadout",
					order: 100,
					create: async (context) => createLoadoutPage(pi, engine, context),
				},
			);
		},
	});
	pi.registerCommand("loadout", {
		description: "Open Loadout.",
		handler: async (_args: string, context: ExtensionCommandContext): Promise<void> => {
			if (context.mode !== "tui") {
				context.ui.notify("/loadout requires TUI mode.", "warning");
				return;
			}
			const session = active;
			if (session === undefined || session.signal.aborted) {
				context.ui.notify("Loadout is not active for this session.", "warning");
				return;
			}
			await openExtensionPageRouter(pi, context, {
				hostId: "@hheei/pi-loadout",
				signal: session.signal,
				maxPending: 1,
				initialPageId: "loadout",
				onSurfaceOpen: () => {
					const lease = suspendHepiWidgets(pi);
					return () => lease.release();
				},
			});
		},
	});
}
