export {
	type ApplyPatchGuard,
	createApplyPatchGuardSettingsProvider,
	GUARD_PATCH_FIELD,
	GUARD_PATCH_GROUP,
	type GuardPatchMode,
	hasStreamingApplyPatchCommand,
	normalizeGuardPatchMode,
	registerApplyPatchGuard,
} from "./apply-patch-guard.js";
export { default } from "./extension.js";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type HePiContext,
	type HePiSettingField,
	type HePiSettingsProvider,
	type HePiSettingsState,
	updateJsonSettingsRoot,
} from "../core/index.js";

export const OPENAI_RESPONSES_COMPAT_GROUP = "openai-responses-compat";
export const OPENAI_RESPONSES_COMPAT_FIELD = "stripAssistantMessageStatus";
export const OPENAI_RESPONSES_NORMALIZE_MESSAGE_ID_FIELD = "normalizeAssistantMessageId";

interface JsonObject {
	[key: string]: unknown;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsPath(settingsDirectory = getAgentDir()): string {
	return join(settingsDirectory, "settings.json");
}

async function loadSettings(path: string): Promise<JsonObject> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return isJsonObject(value) ? value : {};
	} catch (error) {
		if (isJsonObject(error) && error.code === "ENOENT") return {};
		throw error;
	}
}

export interface OpenAIResponsesCompatConfig {
	readonly stripAssistantMessageStatus: boolean;
	readonly normalizeAssistantMessageId: boolean;
}

function configFromValues(values: JsonObject | undefined): OpenAIResponsesCompatConfig {
	if (values === undefined) {
		return { stripAssistantMessageStatus: false, normalizeAssistantMessageId: false };
	}
	for (const key of Object.keys(values)) {
		if (
			key !== OPENAI_RESPONSES_COMPAT_FIELD &&
			key !== OPENAI_RESPONSES_NORMALIZE_MESSAGE_ID_FIELD
		) {
			throw new Error(
				`Invalid settings at pi-basics.${OPENAI_RESPONSES_COMPAT_GROUP}.${key}: unknown field`,
			);
		}
		if (typeof values[key] !== "boolean") {
			throw new Error(
				`Invalid settings at pi-basics.${OPENAI_RESPONSES_COMPAT_GROUP}.${key}: expected boolean`,
			);
		}
	}
	const stripValue = values[OPENAI_RESPONSES_COMPAT_FIELD];
	const normalizeValue = values[OPENAI_RESPONSES_NORMALIZE_MESSAGE_ID_FIELD];
	const stripAssistantMessageStatus = stripValue === true;
	return {
		stripAssistantMessageStatus,
		normalizeAssistantMessageId:
			normalizeValue === undefined ? stripAssistantMessageStatus : normalizeValue === true,
	};
}

function configFromState(state: HePiSettingsState): OpenAIResponsesCompatConfig {
	const values = state[OPENAI_RESPONSES_COMPAT_GROUP];
	return configFromValues(values);
}

function settingState(config: OpenAIResponsesCompatConfig): HePiSettingsState {
	return {
		[OPENAI_RESPONSES_COMPAT_GROUP]: {
			[OPENAI_RESPONSES_COMPAT_FIELD]: config.stripAssistantMessageStatus,
			[OPENAI_RESPONSES_NORMALIZE_MESSAGE_ID_FIELD]: config.normalizeAssistantMessageId,
		},
	};
}

function compatValues(root: JsonObject): JsonObject | undefined {
	const section = isJsonObject(root["pi-basics"]) ? root["pi-basics"] : undefined;
	return section && isJsonObject(section[OPENAI_RESPONSES_COMPAT_GROUP])
		? section[OPENAI_RESPONSES_COMPAT_GROUP]
		: undefined;
}

export function normalizeAssistantMessageId(id: string): string {
	if (!id.startsWith("item_")) return id;
	const digest = createHash("sha256").update(id).digest("hex").slice(0, 40);
	return `msg_pi_${digest}`;
}

export function applyOpenAIResponsesCompat(
	payload: unknown,
	config: OpenAIResponsesCompatConfig,
): unknown {
	if (!isJsonObject(payload) || !Array.isArray(payload.input)) return payload;

	let changed = false;
	const input = payload.input.map((item: unknown) => {
		if (!isJsonObject(item) || item.type !== "message" || item.role !== "assistant") return item;

		let rewritten = item;
		if (config.stripAssistantMessageStatus && "status" in rewritten) {
			rewritten = Object.fromEntries(Object.entries(rewritten).filter(([key]) => key !== "status"));
		}
		if (
			config.normalizeAssistantMessageId &&
			typeof rewritten.id === "string" &&
			rewritten.id.startsWith("item_")
		) {
			rewritten = { ...rewritten, id: normalizeAssistantMessageId(rewritten.id) };
		}
		if (rewritten !== item) changed = true;
		return rewritten;
	});

	return changed ? { ...payload, input } : payload;
}

/** Remove only the unsupported status field from replayed assistant messages. */
export function stripAssistantMessageStatus(payload: unknown): unknown {
	return applyOpenAIResponsesCompat(payload, {
		stripAssistantMessageStatus: true,
		normalizeAssistantMessageId: false,
	});
}

export interface OpenAIResponsesCompatFeature {
	start(runtime: { readonly ctx: ExtensionContext }): Promise<void>;
	dispose(sessionId: string): void;
	setConfig(sessionId: string, config: OpenAIResponsesCompatConfig): void;
}

export function createOpenAIResponsesCompatFeature(
	pi: ExtensionAPI,
	options: { readonly settingsDirectory?: string } = {},
): OpenAIResponsesCompatFeature {
	const settingsDirectory = options.settingsDirectory ?? getAgentDir();
	const configBySession = new Map<string, OpenAIResponsesCompatConfig>();
	pi.on("before_provider_request", async (event, context) => {
		if (context.model?.api !== "openai-responses") return undefined;
		const sessionId = context.sessionManager.getSessionId();
		let config = configBySession.get(sessionId);
		if (config === undefined) {
			const root = await loadSettings(settingsPath(settingsDirectory));
			config = configFromValues(compatValues(root));
			configBySession.set(sessionId, config);
		}
		if (!config.stripAssistantMessageStatus && !config.normalizeAssistantMessageId)
			return undefined;
		return applyOpenAIResponsesCompat(event.payload, config);
	});

	return {
		async start(runtime) {
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			const root = await loadSettings(settingsPath(settingsDirectory));
			configBySession.set(sessionId, configFromValues(compatValues(root)));
		},
		dispose(sessionId) {
			configBySession.delete(sessionId);
		},
		setConfig(sessionId, config) {
			configBySession.set(sessionId, config);
		},
	};
}

const fields: readonly HePiSettingField[] = [
	{
		id: OPENAI_RESPONSES_COMPAT_FIELD,
		label: "Strip status",
		type: "boolean",
		defaultValue: false,
		description:
			"Omit status from assistant message input items for Responses gateways that reject this official field.",
		parse: (value) => value === "true",
	},
	{
		id: OPENAI_RESPONSES_NORMALIZE_MESSAGE_ID_FIELD,
		label: "Normalize IDs",
		type: "boolean",
		defaultValue: false,
		description: "Rewrite replayed assistant message IDs from item_ to the required msg_ prefix.",
		parse: (value) => value === "true",
	},
];

export function createOpenAIResponsesCompatSettingsProvider(
	feature: OpenAIResponsesCompatFeature,
	options: { readonly settingsDirectory?: string } = {},
): HePiSettingsProvider {
	const settingsDirectory = options.settingsDirectory ?? getAgentDir();
	return {
		id: "pi-fix-openai-responses-compat",
		title: "OpenAI Responses compatibility",
		moduleName: "pi-fix",
		origin: "@hheei/hepi-basics",
		groups: [{ id: OPENAI_RESPONSES_COMPAT_GROUP, title: "", fields }],
		storage: {
			async load() {
				const root = await loadSettings(settingsPath(settingsDirectory));
				return settingState(configFromValues(compatValues(root)));
			},
			async save(state: HePiSettingsState, ctx: HePiContext) {
				const path = settingsPath(settingsDirectory);
				const config = configFromState(state);
				const stateValues = state[OPENAI_RESPONSES_COMPAT_GROUP] ?? {};
				await updateJsonSettingsRoot(path, (root) => {
					const priorSection = isJsonObject(root["pi-basics"]) ? root["pi-basics"] : {};
					const priorValues = compatValues(root);
					const nextValues = {
						...(priorValues ?? {}),
						...(OPENAI_RESPONSES_COMPAT_FIELD in stateValues
							? { [OPENAI_RESPONSES_COMPAT_FIELD]: config.stripAssistantMessageStatus }
							: {}),
						...(OPENAI_RESPONSES_NORMALIZE_MESSAGE_ID_FIELD in stateValues ||
						OPENAI_RESPONSES_COMPAT_FIELD in stateValues
							? {
									[OPENAI_RESPONSES_NORMALIZE_MESSAGE_ID_FIELD]: config.normalizeAssistantMessageId,
								}
							: {}),
					};
					root["pi-basics"] = {
						...priorSection,
						[OPENAI_RESPONSES_COMPAT_GROUP]: nextValues,
					};
				});
				feature.setConfig(ctx.sessionId, config);
			},
		},
		onLoad: (state, ctx) => {
			feature.setConfig(ctx.sessionId, configFromState(state));
		},
		onChange: (change, ctx) => {
			if (
				change.fieldId === OPENAI_RESPONSES_COMPAT_FIELD ||
				change.fieldId === OPENAI_RESPONSES_NORMALIZE_MESSAGE_ID_FIELD
			)
				feature.setConfig(ctx.sessionId, configFromState(change.state));
		},
	};
}
