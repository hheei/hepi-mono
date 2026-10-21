import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	getRuntimeSettingsRegistry,
	openExtensionPageRouter,
	registerExtensionLifecycle,
	registerExtensionPage,
	suspendWidgets,
} from "@hheei/pi-ext-core";
import { createSettingsPage } from "./settings-page.js";

interface ActiveSettingsSession {
	readonly signal: AbortSignal;
}

/** Settings router command surface. */
const SETTINGS_COMMAND = "ext-settings";

/** Owns Settings policy and the extension settings page-router entry. */
export default function piSettingsExtension(pi: ExtensionAPI): void {
	let active: ActiveSettingsSession | undefined;

	const openSettings = async (
		initialPageId: string | undefined,
		context: ExtensionCommandContext,
	): Promise<void> => {
		if (context.mode !== "tui") {
			context.ui.notify(`/${SETTINGS_COMMAND} requires TUI mode.`, "warning");
			return;
		}
		const session = active;
		if (session === undefined || session.signal.aborted) {
			context.ui.notify("Settings are not active for this session.", "warning");
			return;
		}
		await openExtensionPageRouter(pi, context, {
			hostId: "@hheei/pi-settings",
			signal: session.signal,
			...(initialPageId === undefined ? {} : { initialPageId }),
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: "100%",
				anchor: "bottom-left",
				margin: 0,
			},
			onSurfaceOpen: () => {
				const lease = suspendWidgets(pi);
				return () => lease.release();
			},
		});
	};

	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-settings",
		start: async ({ extension, signal, resources }) => {
			const session: ActiveSettingsSession = { signal };
			active = session;
			resources.add("settings-session", () => {
				if (active === session) active = undefined;
			});
			registerExtensionPage(
				{ pi, extension, signal, resources },
				{
					id: "settings",
					label: "Settings",
					order: 0,
					create: async (context) => createSettingsPage(getRuntimeSettingsRegistry(pi), context),
				},
			);
		},
	});

	pi.registerCommand(SETTINGS_COMMAND, {
		description: "Open extension settings: /ext-settings [page-id]",
		handler: async (args: string, context: ExtensionCommandContext): Promise<void> => {
			await openSettings(args.trim() || undefined, context);
		},
	});
}
