import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	getHepiRuntimeSettingsRegistry,
	openExtensionPageRouter,
	registerExtensionLifecycle,
	registerExtensionPage,
	suspendHepiWidgets,
} from "@hheei/pi-ext-core";
import { createSettingsPage } from "./settings-page.js";

interface ActiveSettingsSession {
	readonly signal: AbortSignal;
}

/** Owns the sole `/ext-settings` command and composes independently registered pages. */
export default function piSettingsExtension(pi: ExtensionAPI): void {
	let active: ActiveSettingsSession | undefined;
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-settings",
		start: ({ extension, signal, resources, artifacts }) => {
			const session: ActiveSettingsSession = { signal };
			active = session;
			registerExtensionPage(
				{ pi, extension, signal, resources, artifacts },
				{
					id: "settings",
					label: "Settings",
					order: 0,
					create: async (context) =>
						createSettingsPage(getHepiRuntimeSettingsRegistry(pi), context),
				},
			);
			resources.add("settings-session", () => {
				if (active === session) active = undefined;
			});
		},
	});
	pi.registerCommand("ext-settings", {
		description: "Open extension settings.",
		handler: async (args: string, context: ExtensionCommandContext): Promise<void> => {
			if (context.mode !== "tui") {
				context.ui.notify("/ext-settings requires TUI mode.", "warning");
				return;
			}
			const session = active;
			if (session === undefined || session.signal.aborted) {
				context.ui.notify("Settings are not active for this session.", "warning");
				return;
			}
			const initialPageId = args.trim() || undefined;
			await openExtensionPageRouter(pi, context, {
				hostId: "@hheei/pi-settings",
				signal: session.signal,
				maxPending: 1,
				...(initialPageId === undefined ? {} : { initialPageId }),
				overlay: true,
				overlayOptions: {
					width: "100%",
					maxHeight: "100%",
					anchor: "bottom-left",
					margin: 0,
				},
				onSurfaceOpen: () => {
					// Acquire only after the FIFO host owns Pi's custom slot. Queueing an
					// unopened Settings request must never hide editor-adjacent widgets.
					const lease = suspendHepiWidgets(pi);
					return () => lease.release();
				},
			});
		},
	});
}
