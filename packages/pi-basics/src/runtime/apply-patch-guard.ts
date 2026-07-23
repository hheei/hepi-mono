import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	HePiContext,
	HePiSettingField,
	HePiSettingsProvider,
	HePiSettingsState,
} from "../api/settings.js";

export const GUARD_PATCH_GROUP = "guardPatch";
export const GUARD_PATCH_FIELD = "mode";
export type GuardPatchMode = "auto" | "on" | "off";

const APPLY_PATCH_COMMAND = /(?:^|[\n;&|()])\s*(?:command\s+)?apply_patch\s/;
const BLOCK_REASON =
	"`apply_patch` tool is unavailable. Use `edit` for precise changes or `write` for new files/complete rewrites.";
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

function settingsPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

export interface ApplyPatchGuard {
	getMode(): GuardPatchMode;
	setMode(mode: GuardPatchMode): void;
}

export function registerApplyPatchGuard(pi: ExtensionAPI): ApplyPatchGuard {
	let interrupted = false;
	let mode: GuardPatchMode = "auto";
	pi.on("turn_start", () => {
		interrupted = false;
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
		pi.sendMessage(
			{
				customType: "apply-patch-guard",
				content: BLOCK_REASON,
				display: true,
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
		ctx.abort();
	});
	return {
		getMode: () => mode,
		setMode: (value) => {
			mode = normalizeGuardPatchMode(value);
		},
	};
}

function modeFromState(state: HePiSettingsState): GuardPatchMode {
	return normalizeGuardPatchMode(state[GUARD_PATCH_GROUP]?.[GUARD_PATCH_FIELD]);
}

const modeField: HePiSettingField<GuardPatchMode> = {
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
): HePiSettingsProvider {
	return {
		id: "pi-basics-apply-patch-guard",
		title: "Guard patch",
		origin: "@pi-basics",
		groups: [{ id: GUARD_PATCH_GROUP, title: "", fields: [modeField] }],
		storage: {
			async load(ctx: HePiContext) {
				const root = await readRoot(settingsPath(ctx.cwd ?? process.cwd()));
				const section = root[SETTINGS_SECTION];
				const group = isJsonObject(section) ? section[GUARD_PATCH_GROUP] : undefined;
				return {
					[GUARD_PATCH_GROUP]: {
						mode: normalizeGuardPatchMode(isJsonObject(group) ? group.mode : undefined),
					},
				};
			},
			async save(state: HePiSettingsState, ctx: HePiContext) {
				const path = settingsPath(ctx.cwd ?? process.cwd());
				const root = await readRoot(path);
				const existing = root[SETTINGS_SECTION];
				const section = isJsonObject(existing) ? { ...existing } : {};
				const mode = modeFromState(state);
				section[GUARD_PATCH_GROUP] = { mode };
				root[SETTINGS_SECTION] = section;
				await mkdir(dirname(path), { recursive: true });
				const temporary = `${path}.guard-patch.tmp`;
				await writeFile(temporary, `${JSON.stringify(root, null, 2)}\n`, "utf8");
				await rename(temporary, path);
				guard.setMode(mode);
			},
		},
		onLoad: (state) => guard.setMode(modeFromState(state)),
		onChange: (change) => guard.setMode(modeFromState(change.state)),
	};
}
