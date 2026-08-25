import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	getDisabledSkillKeys,
	getRuntimeSettingsRegistry,
	openExtensionPageRouter,
	registerExtensionLifecycle,
	registerExtensionPage,
	suspendWidgets,
} from "@hheei/pi-ext-core";
import { createLoadoutEngine } from "./loadout/engine.js";
import { createLoadoutPage } from "./loadout/page.js";
import { createSettingsPage } from "./settings-page.js";

interface ActiveSettingsSession {
	readonly signal: AbortSignal;
}

const AVAILABLE_SKILLS_SECTION =
	/\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
const AVAILABLE_SKILL_ENTRY =
	/\n {2}<skill>\n {4}<name>([^<\n]+)<\/name>\n[\s\S]*?\n {2}<\/skill>/g;

/** Pi exposes generated skill XML, so filter only the documented skill entries before each turn. */
export function filterDisabledSkillsFromSystemPrompt(
	systemPrompt: string,
	disabledSkillKeys: ReadonlySet<string>,
): string {
	if (disabledSkillKeys.size === 0) return systemPrompt;
	const section = systemPrompt.match(AVAILABLE_SKILLS_SECTION)?.[0];
	if (section === undefined) return systemPrompt;
	const filtered = section.replace(AVAILABLE_SKILL_ENTRY, (entry, name: string) =>
		disabledSkillKeys.has(`skill:${name}`) ? "" : entry,
	);
	return filtered.includes("\n  <skill>")
		? systemPrompt.replace(section, filtered)
		: systemPrompt.replace(section, "");
}

/** Owns Settings and Loadout policy plus their two direct page-router entries. */
export default function piSettingsExtension(pi: ExtensionAPI): void {
	let active: ActiveSettingsSession | undefined;
	const loadout = createLoadoutEngine(pi);
	pi.on("before_agent_start", (event) => {
		if (active === undefined || active.signal.aborted) return;
		const systemPrompt = filterDisabledSkillsFromSystemPrompt(
			event.systemPrompt,
			getDisabledSkillKeys(pi),
		);
		return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
	});
	const openSettings = async (
		initialPageId: string | undefined,
		commandName: "/ext-settings" | "/loadout",
		inactiveMessage: string,
		context: ExtensionCommandContext,
	): Promise<void> => {
		if (context.mode !== "tui") {
			context.ui.notify(`${commandName} requires TUI mode.`, "warning");
			return;
		}
		const session = active;
		if (session === undefined || session.signal.aborted) {
			context.ui.notify(inactiveMessage, "warning");
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
		start: async ({ extension, signal, resources, outputs }) => {
			const session: ActiveSettingsSession = { signal };
			active = session;
			resources.add("settings-session", () => {
				if (active === session) active = undefined;
			});
			await loadout.start(extension, signal);
			resources.add("loadout-engine", () => loadout.dispose());
			registerExtensionPage(
				{ pi, extension, signal, resources, outputs },
				{
					id: "settings",
					label: "Settings",
					order: 0,
					create: async (context) => createSettingsPage(getRuntimeSettingsRegistry(pi), context),
				},
			);
			registerExtensionPage(
				{ pi, extension, signal, resources, outputs },
				{
					id: "loadout",
					label: "Loadout",
					order: 100,
					create: async (context) => createLoadoutPage(pi, loadout, context),
				},
			);
		},
	});
	pi.registerCommand("ext-settings", {
		description: "Open extension settings.",
		handler: async (args: string, context: ExtensionCommandContext): Promise<void> => {
			await openSettings(
				args.trim() || undefined,
				"/ext-settings",
				"Settings are not active for this session.",
				context,
			);
		},
	});
	pi.registerCommand("loadout", {
		description: "Open Loadout.",
		handler: async (_args: string, context: ExtensionCommandContext): Promise<void> => {
			await openSettings("loadout", "/loadout", "Loadout is not active for this session.", context);
		},
	});
}
