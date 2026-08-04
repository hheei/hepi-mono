import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import {
	type CavemanDefaults,
	type CavemanSettingsProviderOptions,
	DEFAULT_CAVEMAN_DEFAULTS,
	loadCavemanDefaults,
} from "./config.js";
import { registerCavemanSettings } from "./hepi-settings.js";
import {
	CAVEMAN_STATE_ENTRY,
	type CavemanMode,
	DEFAULT_CAVEMAN_MODE,
	detectCavemanIntent,
	parseCavemanCommand,
	restoreCavemanMode,
} from "./mode.js";
import { buildCavemanPrompt } from "./prompt.js";
import {
	hasSubagentPromptMarker,
	injectSubagentPrompt,
	isAgentToolInput,
	isPiSubagentSession,
} from "./subagents.js";

const COMMAND_VALUES = [
	"lite",
	"full",
	"ultra",
	"wenyan",
	"wenyan-lite",
	"wenyan-full",
	"wenyan-ultra",
	"off",
	"status",
] as const;
const COMMAND_DESCRIPTIONS: Record<(typeof COMMAND_VALUES)[number], string> = {
	lite: "Use concise replies while preserving normal explanatory detail.",
	full: "Use the default compressed Caveman response style.",
	ultra: "Use the shortest Caveman response style with minimal prose.",
	wenyan: "Use the default Classical Chinese Caveman response style.",
	"wenyan-lite": "Use concise Classical Chinese with moderate detail.",
	"wenyan-full": "Use the default compressed Classical Chinese style.",
	"wenyan-ultra": "Use the shortest Classical Chinese response style.",
	off: "Disable Caveman prompt injection for the current session branch.",
	status: "Print the active Caveman mode without changing it.",
};

export interface CavemanExtensionOptions extends CavemanSettingsProviderOptions {}

export default function piCavemanExtension(
	pi: ExtensionAPI,
	options: CavemanExtensionOptions = {},
): void {
	let defaults: CavemanDefaults = DEFAULT_CAVEMAN_DEFAULTS;
	let mode: CavemanMode = DEFAULT_CAVEMAN_MODE;
	let subagentSession = false;
	let active: { extension: ExtensionContext; signal: AbortSignal } | undefined;

	function configuredDefaultMode(): CavemanMode {
		return subagentSession ? defaults.subagentMode : defaults.mainMode;
	}

	function setMode(nextMode: CavemanMode, _ctx: ExtensionContext): void {
		const changed = mode !== nextMode;
		mode = nextMode;
		if (changed) {
			pi.appendEntry(CAVEMAN_STATE_ENTRY, { version: 1, mode });
		}
	}

	pi.registerCommand("caveman", {
		description: "Set concise response mode: lite, full, ultra, wenyan, off, or status",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const matches = COMMAND_VALUES.filter((value) => value.startsWith(normalized)).map(
				(value) => ({ value, label: value, description: COMMAND_DESCRIPTIONS[value] }),
			);
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			if (activeSession() === undefined) return;
			const command = parseCavemanCommand(args);
			switch (command.kind) {
				case "set":
					setMode(command.mode, ctx);
					ctx.ui.notify(
						command.mode === "off"
							? "※ Caveman mode disabled."
							: `※ Caveman mode enabled: ${command.mode}.`,
					);
					return;
				case "status":
					ctx.ui.notify(`Caveman mode: ${mode}`, "info");
					return;
				case "invalid":
					ctx.ui.notify(
						`Unknown caveman mode: ${command.value || "(empty)"}. Use lite, full, ultra, wenyan, off, or status.`,
						"error",
					);
					return;
				default:
					command satisfies never;
			}
		},
	});

	function restoreModeFromBranch(ctx: ExtensionContext): void {
		mode = restoreCavemanMode(ctx.sessionManager.getBranch(), configuredDefaultMode());
	}

	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-caveman",
		start: async (context) => {
			const session = { extension: context.extension, signal: context.signal };
			active = session;
			// Raw Pi handlers remain installed across reload; identity check makes stale ones inert.
			context.resources.add("active-session", () => {
				if (active === session) active = undefined;
			});
			context.resources.add("settings", registerCavemanSettings(pi, options));
			// Settings reads and Agent re-reads must stop with lifecycle shutdown.
			defaults = await loadCavemanDefaults(options.settingsFilePath, {
				cwd: context.extension.cwd,
				signal: context.signal,
			});
			subagentSession = isPiSubagentSession(pi);
			restoreModeFromBranch(context.extension);
		},
	});

	const activeSession = ():
		| {
				extension: ExtensionContext;
				signal: AbortSignal;
		  }
		| undefined => {
		const session = active;
		return session !== undefined && !session.signal.aborted ? session : undefined;
	};
	pi.on("session_tree", (_event, ctx) => {
		if (activeSession() !== undefined) restoreModeFromBranch(ctx);
	});
	pi.on("input", (event, ctx) => {
		if (activeSession() === undefined || event.source === "extension")
			return { action: "continue" };
		const requestedMode = detectCavemanIntent(event.text);
		if (requestedMode !== undefined) setMode(requestedMode, ctx);
		return { action: "continue" };
	});
	pi.on("tool_call", async (event) => {
		const session = activeSession();
		if (session === undefined || event.toolName !== "Agent" || !isAgentToolInput(event.input))
			return undefined;
		const loaded = await loadCavemanDefaults(options.settingsFilePath, {
			cwd: session.extension.cwd,
			signal: session.signal,
		});
		if (active !== session || session.signal.aborted) return undefined;
		defaults = loaded;
		event.input.prompt = injectSubagentPrompt(event.input.prompt, defaults.subagentMode);
		return undefined;
	});
	pi.on("before_agent_start", (event) => {
		if (activeSession() === undefined || hasSubagentPromptMarker(event.prompt)) return undefined;
		const prompt = buildCavemanPrompt(mode);
		if (prompt === undefined) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
}
