import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OverlayOptions } from "@earendil-works/pi-tui";
import {
	getDisabledSkillKeys,
	openExtensionPageRouter,
	registerExtensionLifecycle,
	registerExtensionPage,
	registerLoadoutHost,
	suspendHepiWidgets,
} from "@hheei/pi-ext-core";
import { createLoadoutEngine } from "./engine.js";
import { createLoadoutPage } from "./page.js";

interface ActiveLoadoutSession {
	readonly signal: AbortSignal;
}

const AVAILABLE_SKILLS_SECTION =
	/\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
const AVAILABLE_SKILL_ENTRY =
	/\n {2}<skill>\n {4}<name>([^<\n]+)<\/name>\n[\s\S]*?\n {2}<\/skill>/g;

/**
 * Pi 0.83 exposes the generated prompt, not its skill list, to before_agent_start.
 * Keep this compatibility bridge local and test the host's XML envelope explicitly.
 */
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

export default function piLoadoutExtension(pi: ExtensionAPI): void {
	// The command starts on Loadout but uses the shared router. This keeps page rendering
	// and widget suspension identical to /ext-settings without importing pi-settings.
	let active: ActiveLoadoutSession | undefined;
	const engine = createLoadoutEngine(pi);
	pi.on("before_agent_start", (event) => {
		const systemPrompt = filterDisabledSkillsFromSystemPrompt(
			event.systemPrompt,
			getDisabledSkillKeys(pi),
		);
		return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
	});
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-loadout",
		start: async ({ extension, signal, resources, artifacts }) => {
			resources.add("loadout-host", registerLoadoutHost(pi));
			const session: ActiveLoadoutSession = { signal };
			active = session;
			resources.add("loadout-session", () => {
				if (active === session) active = undefined;
			});
			await engine.start(extension, signal);
			resources.add("loadout-engine", () => engine.dispose());
			registerExtensionPage(
				{ pi, extension, signal, resources, artifacts },
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
				overlay: true,
				overlayOptions: {
					width: "100%",
					maxHeight: "100%",
					anchor: "bottom-left",
					margin: 0,
				} satisfies OverlayOptions,
				onSurfaceOpen: () => {
					const lease = suspendHepiWidgets(pi);
					return () => lease.release();
				},
			});
		},
	});
}
