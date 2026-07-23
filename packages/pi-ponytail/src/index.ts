import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_PONYTAIL_DEFAULTS,
	loadPonytailDefaults,
	type PonytailDefaults,
} from "./config.js";
import { registerPonytailHePiSettings } from "./hepi-settings.js";
import {
	DEFAULT_PONYTAIL_MODE,
	detectPonytailDeactivation,
	PONYTAIL_STATE_ENTRY,
	type PonytailMode,
	parsePonytailCommand,
	ponytailStatusLabel,
	restorePonytailMode,
} from "./mode.js";
import { buildPonytailPrompt } from "./prompt.js";
import {
	hasSubagentPromptMarker,
	injectSubagentPrompt,
	isAgentToolInput,
	isPiSubagentSession,
} from "./subagents.js";

const COMMAND_VALUES = ["lite", "full", "ultra", "off", "status"] as const;

export default async function piPonytailExtension(pi: ExtensionAPI): Promise<void> {
	await registerPonytailHePiSettings();
	let defaults: PonytailDefaults = DEFAULT_PONYTAIL_DEFAULTS;
	let mode: PonytailMode = DEFAULT_PONYTAIL_MODE;
	let subagentSession = false;

	function configuredDefaultMode(): PonytailMode {
		return subagentSession ? defaults.subagentMode : defaults.mainMode;
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("pi-ponytail", defaults.hideStatus ? undefined : ponytailStatusLabel(mode));
	}

	function setMode(nextMode: PonytailMode, ctx: ExtensionContext): void {
		const changed = mode !== nextMode;
		mode = nextMode;
		updateStatus(ctx);
		if (changed) {
			pi.appendEntry(PONYTAIL_STATE_ENTRY, { version: 1, mode });
		}
	}

	pi.registerCommand("ponytail", {
		description: "Set minimal-engineering mode: lite, full, ultra, off, or status",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const matches = COMMAND_VALUES.filter((value) => value.startsWith(normalized)).map(
				(value) => ({ value, label: value }),
			);
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const command = parsePonytailCommand(args);
			switch (command.kind) {
				case "set":
					setMode(command.mode, ctx);
					ctx.ui.notify(
						command.mode === "off" ? "Ponytail mode off" : `Ponytail mode: ${command.mode}`,
						"info",
					);
					return;
				case "status":
					ctx.ui.notify(`Ponytail mode: ${mode}`, "info");
					return;
				case "invalid":
					ctx.ui.notify(
						`Unknown ponytail mode: ${command.value || "(empty)"}. Use lite, full, ultra, off, or status.`,
						"error",
					);
					return;
				default:
					command satisfies never;
			}
		},
	});

	function restoreModeFromBranch(ctx: ExtensionContext): void {
		mode = restorePonytailMode(ctx.sessionManager.getBranch(), configuredDefaultMode());
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		defaults = await loadPonytailDefaults(ctx.cwd);
		subagentSession = isPiSubagentSession(pi);
		restoreModeFromBranch(ctx);
		if (!defaults.quietStartup && !subagentSession) {
			ctx.ui.notify(`Ponytail loaded: ${mode}`, "info");
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreModeFromBranch(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (detectPonytailDeactivation(event.text)) setMode("off", ctx);
		return { action: "continue" };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "Agent" || !isAgentToolInput(event.input)) return undefined;
		defaults = await loadPonytailDefaults(ctx.cwd);
		event.input.prompt = injectSubagentPrompt(event.input.prompt, defaults.subagentMode);
		return undefined;
	});

	pi.on("before_agent_start", (event) => {
		if (hasSubagentPromptMarker(event.prompt)) return undefined;
		const prompt = buildPonytailPrompt(mode);
		if (prompt === undefined) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("pi-ponytail", undefined);
	});
}

export {
	createPonytailSettingsProvider,
	DEFAULT_PONYTAIL_DEFAULTS,
	loadPonytailDefaults,
	PONYTAIL_DEFAULTS_GROUP,
	PONYTAIL_HIDE_STATUS_FIELD,
	PONYTAIL_MAIN_MODE_FIELD,
	PONYTAIL_QUIET_STARTUP_FIELD,
	PONYTAIL_SETTINGS_PROVIDER_ID,
	PONYTAIL_SUBAGENT_MODE_FIELD,
	type PonytailDefaults,
} from "./config.js";
export { registerPonytailHePiSettings } from "./hepi-settings.js";
export {
	DEFAULT_PONYTAIL_MODE,
	detectPonytailDeactivation,
	isPonytailIntensity,
	PONYTAIL_INTENSITIES,
	PONYTAIL_STATE_ENTRY,
	type PonytailCommand,
	type PonytailIntensity,
	type PonytailMode,
	parsePonytailCommand,
	ponytailStatusLabel,
	restorePonytailMode,
} from "./mode.js";
export { buildPonytailPrompt } from "./prompt.js";
export {
	hasSubagentPromptMarker,
	injectSubagentPrompt,
	isAgentToolInput,
	isPiSubagentSession,
	PONYTAIL_SUBAGENT_MARKER,
} from "./subagents.js";
