import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { openTuiSurface, registerExtensionLifecycle, suspendWidgets } from "@hheei/pi-ext-core";
import { LoadoutManager } from "./loadout-manager.js";
import { LoadoutView } from "./loadout-view.js";

interface ActiveLoadoutSession {
	readonly signal: AbortSignal;
}

const LOADOUT_COMMAND = "ext-loadout";
const LOADOUT_ALIAS = "loadout";

export default function piLoadoutExtension(pi: ExtensionAPI): void {
	let active: ActiveLoadoutSession | undefined;

	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-loadout",
		start: async ({ signal, resources }) => {
			const session: ActiveLoadoutSession = { signal };
			active = session;
			resources.add("loadout-session", () => {
				if (active === session) active = undefined;
			});
		},
	});

	const openLoadout = async (context: ExtensionCommandContext): Promise<void> => {
		if (context.mode !== "tui") {
			context.ui.notify(`/${LOADOUT_COMMAND} requires TUI mode.`, "warning");
			return;
		}
		const session = active;
		if (session === undefined || session.signal.aborted) {
			context.ui.notify("Loadout is not active for this session.", "warning");
			return;
		}

		let manager: LoadoutManager | undefined;

		await openTuiSurface(pi, context, {
			hostId: "@hheei/pi-loadout",
			signal: session.signal,
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: "100%",
				anchor: "bottom-left",
				margin: 0,
			},
			create: async (surfaceContext) => {
				const widgetLease = suspendWidgets(pi);
				manager = new LoadoutManager({
					cwd: context.cwd,
					agentDir: getAgentDir(),
				});
				await manager.refresh();

				return new LoadoutView({
					manager,
					theme: surfaceContext.theme,
					requestRender: () => surfaceContext.requestRender(),
					onClose: () => {
						widgetLease.release();
						surfaceContext.close(undefined);
					},
				});
			},
			beforeRelease: async () => {
				if (manager) {
					await manager.flush();
					context.ui.notify("Loadout configuration saved. Run /reload to apply changes.", "info");
				}
			},
		});
	};

	pi.registerCommand(LOADOUT_COMMAND, {
		description: "Open resource loadout manager: /ext-loadout",
		handler: async (_args: string, context: ExtensionCommandContext): Promise<void> => {
			await openLoadout(context);
		},
	});

	pi.registerCommand(LOADOUT_ALIAS, {
		description: "Alias for /ext-loadout",
		handler: async (_args: string, context: ExtensionCommandContext): Promise<void> => {
			await openLoadout(context);
		},
	});
}
