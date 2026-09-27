import type { ExtensionAPI, ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import {
	getRuntimeSettingsRegistry,
	isSkillEnabled,
	openExtensionPageRouter,
	registerExtensionLifecycle,
	registerExtensionPage,
	suspendWidgets,
} from "@hheei/pi-ext-core";
import { createLoadoutEngine } from "./loadout/engine.js";
import { createLoadoutPage } from "./loadout/page.js";
import { LOADOUT_SETTINGS_KEY } from "./loadout/storage.js";
import { createSettingsPage } from "./settings-page.js";

interface ActiveSettingsSession {
	readonly signal: AbortSignal;
}

/** Loadout is a page of the Settings router, so this is the only command surface. */
const SETTINGS_COMMAND = "ext-settings";

/** Keeps the skills Loadout still enables; Pi renders the skill section from this list. */
export function filterEnabledSkills(pi: ExtensionAPI, skills: readonly Skill[]): Skill[] {
	return skills.filter((skill) => isSkillEnabled(pi, skill.name));
}

/** Owns Settings and Loadout policy plus their two direct page-router entries. */
export default function piSettingsExtension(pi: ExtensionAPI): void {
	let active: ActiveSettingsSession | undefined;
	const loadout = createLoadoutEngine(pi);
	pi.on("before_agent_start", (event) => {
		if (active === undefined || active.signal.aborted) return;
		const skills = event.systemPromptOptions.skills;
		const enabled = filterEnabledSkills(pi, skills);
		// Pi builds the skill section from this list, so a disabled skill never reaches the prompt.
		if (enabled.length !== skills.length) event.systemPromptOptions.skills = enabled;
	});
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
			resources.add(
				"loadout-settings-group",
				getRuntimeSettingsRegistry(pi).registerGroups("@hheei/pi-settings/loadout", [
					LOADOUT_SETTINGS_KEY,
				]),
			);
			await loadout.start(extension, signal);
			resources.add("loadout-engine", () => loadout.dispose());
			registerExtensionPage(
				{ pi, extension, signal, resources },
				{
					id: "settings",
					label: "Settings",
					order: 0,
					create: async (context) => createSettingsPage(getRuntimeSettingsRegistry(pi), context),
				},
			);
			registerExtensionPage(
				{ pi, extension, signal, resources },
				{
					id: "loadout",
					label: "Loadout",
					order: 100,
					create: async (context) => createLoadoutPage(pi, loadout, context),
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
