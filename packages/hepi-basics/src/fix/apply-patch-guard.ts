import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type HepiSettingField,
	type HepiSettingsProvider,
	type HepiSettingsState,
	updateJsonSettingsRoot,
} from "../core/index.js";

export const GUARD_PATCH_GROUP = "guardPatch";
export const GUARD_PATCH_FIELD = "mode";
export type GuardPatchMode = "auto" | "on" | "off";

const APPLY_PATCH_COMMAND = /(?:^|[\n;&|()])\s*(?:command\s+)?apply_patch\s/;
const BLOCK_REASON =
	"`apply_patch` is unavailable; the call was aborted. Continue with `edit` or `write`. Do not retry `apply_patch`.";
const SETTINGS_SECTION = "pi-basics";
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeGuardPatchMode(value: unknown): GuardPatchMode {
	return value === "on" || value === "off" ? value : "auto";
}

export function hasStreamingApplyPatchCommand(command: string): boolean {
	return APPLY_PATCH_COMMAND.test(command);
}

async function readRoot(path: string): Promise<JsonObject> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return isJsonObject(parsed) ? parsed : {};
	} catch (error) {
		if (isJsonObject(error) && error.code === "ENOENT") return {};
		throw error;
	}
}

function settingsPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "settings.json");
}

export interface ApplyPatchGuard {
	getMode(): GuardPatchMode;
	setMode(mode: GuardPatchMode): void;
}

export function registerApplyPatchGuard(pi: ExtensionAPI): ApplyPatchGuard {
	let interrupted = false;
	let pendingInjection = false;
	let mode: GuardPatchMode = "auto";
	pi.on("before_agent_start", () => {
		interrupted = false;
	});
	pi.on("session_start", () => {
		interrupted = false;
		pendingInjection = false;
	});
	pi.on("agent_settled", () => {
		if (!pendingInjection) return;
		pendingInjection = false;
		pi.sendMessage(
			{
				customType: "apply-patch-guard",
				content: BLOCK_REASON,
				display: true,
			},
			{ triggerTurn: true },
		);
	});
	pi.on("session_shutdown", () => {
		pendingInjection = false;
	});
	pi.on("message_update", (event, ctx) => {
		if (interrupted || event.assistantMessageEvent.type !== "toolcall_delta") return;
		const enabled =
			mode === "on" ||
			(mode === "auto" && !pi.getAllTools().some((tool) => tool.name === "apply_patch"));
		if (!enabled) return;
		const update = event.assistantMessageEvent;
		const content = update.partial.content[update.contentIndex];
		if (content?.type !== "toolCall" || content.name !== "bash") return;
		const command = content.arguments.command;
		if (typeof command !== "string" || !hasStreamingApplyPatchCommand(command)) return;
		interrupted = true;
		pendingInjection = true;
		ctx.abort();
	});
	return {
		getMode: () => mode,
		setMode: (value) => {
			mode = normalizeGuardPatchMode(value);
		},
	};
}

function modeFromState(state: HepiSettingsState): GuardPatchMode {
	return normalizeGuardPatchMode(state[GUARD_PATCH_GROUP]?.[GUARD_PATCH_FIELD]);
}

const modeField: HepiSettingField<GuardPatchMode> = {
	id: GUARD_PATCH_FIELD,
	label: "Guard patch",
	type: "enum",
	defaultValue: "auto",
	options: [
		{ value: "auto", label: "auto" },
		{ value: "on", label: "on" },
		{ value: "off", label: "off" },
	],
	description: "Abort streamed bash apply_patch commands when the tool is unavailable.",
	parse: normalizeGuardPatchMode,
};

export function createApplyPatchGuardSettingsProvider(
	guard: ApplyPatchGuard,
	options: { readonly agentDir?: string } = {},
): HepiSettingsProvider {
	const agentDir = options.agentDir ?? getAgentDir();
	return {
		id: "pi-fix-apply-patch-guard",
		title: "Guard patch",
		origin: "@hheei/hepi-basics",
		moduleName: "pi-fix",
		groups: [{ id: GUARD_PATCH_GROUP, title: "Compatibility", fields: [modeField] }],
		storage: {
			async load() {
				const root = await readRoot(settingsPath(agentDir));
				const section = root[SETTINGS_SECTION];
				const group = isJsonObject(section) ? section[GUARD_PATCH_GROUP] : undefined;
				return {
					[GUARD_PATCH_GROUP]: {
						mode: normalizeGuardPatchMode(isJsonObject(group) ? group.mode : undefined),
					},
				};
			},
			async save(state: HepiSettingsState) {
				const path = settingsPath(agentDir);
				const mode = modeFromState(state);
				await updateJsonSettingsRoot(path, (root) => {
					const existing = root[SETTINGS_SECTION];
					const section = isJsonObject(existing) ? { ...existing } : {};
					section[GUARD_PATCH_GROUP] = { mode };
					root[SETTINGS_SECTION] = section;
				});
				guard.setMode(mode);
			},
		},
		onLoad: (state) => guard.setMode(modeFromState(state)),
		onChange: (change) => guard.setMode(modeFromState(change.state)),
	};
}
