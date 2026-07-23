import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type CavemanDefaults,
	createCavemanSettingsProvider,
	DEFAULT_CAVEMAN_DEFAULTS,
	loadCavemanDefaults,
} from "./config.js";
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

export default function piCavemanExtension(pi: ExtensionAPI): void {
	let defaults: CavemanDefaults = DEFAULT_CAVEMAN_DEFAULTS;
	let mode: CavemanMode = DEFAULT_CAVEMAN_MODE;
	let subagentSession = false;

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

	pi.on("session_start", async (_event, ctx) => {
		pi.events.emit("hepi:settings:register", createCavemanSettingsProvider());
		defaults = await loadCavemanDefaults(ctx.cwd);
		subagentSession = isPiSubagentSession(pi);
		restoreModeFromBranch(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreModeFromBranch(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const requestedMode = detectCavemanIntent(event.text);
		if (requestedMode !== undefined) setMode(requestedMode, ctx);
		return { action: "continue" };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "Agent" || !isAgentToolInput(event.input)) return undefined;
		defaults = await loadCavemanDefaults(ctx.cwd);
		event.input.prompt = injectSubagentPrompt(event.input.prompt, defaults.subagentMode);
		return undefined;
	});

	pi.on("before_agent_start", (event) => {
		if (hasSubagentPromptMarker(event.prompt)) return undefined;
		const prompt = buildCavemanPrompt(mode);
		if (prompt === undefined) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
}

export {
	CAVEMAN_DEFAULTS_GROUP,
	CAVEMAN_MAIN_MODE_FIELD,
	CAVEMAN_SETTINGS_PROVIDER_ID,
	CAVEMAN_SUBAGENT_MODE_FIELD,
	type CavemanDefaults,
	createCavemanSettingsProvider,
	DEFAULT_CAVEMAN_DEFAULTS,
	loadCavemanDefaults,
} from "./config.js";
export { registerCavemanHePiSettings } from "./hepi-settings.js";
export {
	CAVEMAN_INTENSITIES,
	CAVEMAN_STATE_ENTRY,
	type CavemanCommand,
	type CavemanIntensity,
	type CavemanMode,
	cavemanStatusLabel,
	DEFAULT_CAVEMAN_MODE,
	detectCavemanIntent,
	isCavemanIntensity,
	parseCavemanCommand,
	restoreCavemanMode,
} from "./mode.js";
export { buildCavemanPrompt } from "./prompt.js";
export {
	CAVEMAN_SUBAGENT_MARKER,
	hasSubagentPromptMarker,
	injectSubagentPrompt,
	isAgentToolInput,
	isPiSubagentSession,
} from "./subagents.js";
