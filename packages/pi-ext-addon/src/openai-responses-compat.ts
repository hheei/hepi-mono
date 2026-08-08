import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	defaultPiSettingsPaths,
	type HepiContext,
	type HepiSettingField,
	type HepiSettingsProvider,
	type HepiSettingsState,
	readJsonSettingsSection,
	readMergedJsonSettingsSection,
	updateJsonSettingsRoot,
} from "@hheei/pi-ext-core";

export const OPENAI_RESPONSES_COMPAT_GROUP = "openai-responses-compat";
export const OPENAI_RESPONSES_COMPAT_FIELD = "stripAssistantMessageStatus";
export const OPENAI_RESPONSES_NORMALIZE_MESSAGE_ID_FIELD = "normalizeAssistantMessageId";
export const OPENAI_RESPONSES_COMPAT_SETTINGS_SECTION = "pi-ext-addon";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
				`Invalid settings at ${OPENAI_RESPONSES_COMPAT_SETTINGS_SECTION}.${OPENAI_RESPONSES_COMPAT_GROUP}.${key}: unknown field`,
			);
		}
		if (typeof values[key] !== "boolean") {
			throw new Error(
				`Invalid settings at ${OPENAI_RESPONSES_COMPAT_SETTINGS_SECTION}.${OPENAI_RESPONSES_COMPAT_GROUP}.${key}: expected boolean`,
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

function configFromState(state: HepiSettingsState): OpenAIResponsesCompatConfig {
	const values = state[OPENAI_RESPONSES_COMPAT_GROUP];
	return configFromValues(values);
}

function settingState(config: OpenAIResponsesCompatConfig): HepiSettingsState {
	return {
		[OPENAI_RESPONSES_COMPAT_GROUP]: {
			[OPENAI_RESPONSES_COMPAT_FIELD]: config.stripAssistantMessageStatus,
			[OPENAI_RESPONSES_NORMALIZE_MESSAGE_ID_FIELD]: config.normalizeAssistantMessageId,
		},
	};
}

function compatValues(section: JsonObject | undefined): JsonObject | undefined {
	return section && isJsonObject(section[OPENAI_RESPONSES_COMPAT_GROUP])
		? section[OPENAI_RESPONSES_COMPAT_GROUP]
		: undefined;
}

async function loadConfig(
	settingsFilePath: string | undefined,
	context: Pick<HepiContext, "cwd" | "signal"> | undefined,
): Promise<OpenAIResponsesCompatConfig> {
	const section =
		settingsFilePath === undefined
			? (
					await readMergedJsonSettingsSection({
						paths: defaultPiSettingsPaths(context?.cwd),
						section: OPENAI_RESPONSES_COMPAT_SETTINGS_SECTION,
						...(context?.signal === undefined ? {} : { signal: context.signal }),
					})
				).merged
			: await readJsonSettingsSection(
					settingsFilePath,
					OPENAI_RESPONSES_COMPAT_SETTINGS_SECTION,
					context?.signal,
				);
	return configFromValues(compatValues(section));
}

function settingsContext(context: ExtensionContext): Pick<HepiContext, "cwd" | "signal"> {
	return {
		...(context.cwd === undefined ? {} : { cwd: context.cwd }),
		...(context.signal === undefined ? {} : { signal: context.signal }),
	};
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
		if (!isJsonObject(item)) return item;
		const isAssistantMessage = item.type === "message" && item.role === "assistant";
		if (!isAssistantMessage && item.type !== "reasoning") return item;

		let rewritten = item;
		if (config.stripAssistantMessageStatus && "status" in rewritten) {
			rewritten = Object.fromEntries(Object.entries(rewritten).filter(([key]) => key !== "status"));
		}
		if (
			isAssistantMessage &&
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

/** Remove unsupported status fields from replayed Responses input items. */
export function stripAssistantMessageStatus(payload: unknown): unknown {
	return applyOpenAIResponsesCompat(payload, {
		stripAssistantMessageStatus: true,
		normalizeAssistantMessageId: false,
	});
}

export interface OpenAIResponsesCompatFeature {
	start(runtime: { readonly ctx: ExtensionContext }): Promise<void>;
	dispose(sessionId: string): void;
}

export interface OpenAIResponsesCompatOptions {
	readonly settingsFilePath?: string;
}

export function createOpenAIResponsesCompatFeature(
	pi: ExtensionAPI,
	options: OpenAIResponsesCompatOptions = {},
): OpenAIResponsesCompatFeature {
	const configBySession = new Map<string, OpenAIResponsesCompatConfig>();
	pi.on("before_provider_request", async (event, context) => {
		if (context.model?.api !== "openai-responses") return undefined;
		const sessionId = context.sessionManager.getSessionId();
		let config = configBySession.get(sessionId);
		if (config === undefined) {
			config = await loadConfig(options.settingsFilePath, settingsContext(context));
			configBySession.set(sessionId, config);
		}
		if (!config.stripAssistantMessageStatus && !config.normalizeAssistantMessageId)
			return undefined;
		return applyOpenAIResponsesCompat(event.payload, config);
	});

	return {
		async start(runtime): Promise<void> {
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			configBySession.set(
				sessionId,
				await loadConfig(options.settingsFilePath, settingsContext(runtime.ctx)),
			);
		},
		dispose(sessionId): void {
			configBySession.delete(sessionId);
		},
	};
}

const fields: readonly HepiSettingField[] = [
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
	options: OpenAIResponsesCompatOptions = {},
): HepiSettingsProvider {
	return {
		id: "pi-ext-addon-openai-responses-compat",
		title: "OpenAI Responses compatibility",
		origin: "@hheei/pi-ext-addon",
		groups: [{ id: OPENAI_RESPONSES_COMPAT_GROUP, title: "", fields }],
		storage: {
			async load(context): Promise<HepiSettingsState> {
				return settingState(await loadConfig(options.settingsFilePath, context));
			},
			async save(state: HepiSettingsState, context): Promise<void> {
				const config = configFromState(state);
				const stateValues = state[OPENAI_RESPONSES_COMPAT_GROUP] ?? {};
				await updateJsonSettingsRoot(
					options.settingsFilePath ?? join(getAgentDir(), "settings.json"),
					(root) => {
						const priorSection = isJsonObject(root[OPENAI_RESPONSES_COMPAT_SETTINGS_SECTION])
							? root[OPENAI_RESPONSES_COMPAT_SETTINGS_SECTION]
							: {};
						const priorValues = compatValues(priorSection);
						const nextValues = {
							...(priorValues ?? {}),
							...(OPENAI_RESPONSES_COMPAT_FIELD in stateValues
								? { [OPENAI_RESPONSES_COMPAT_FIELD]: config.stripAssistantMessageStatus }
								: {}),
							...(OPENAI_RESPONSES_NORMALIZE_MESSAGE_ID_FIELD in stateValues ||
							OPENAI_RESPONSES_COMPAT_FIELD in stateValues
								? {
										[OPENAI_RESPONSES_NORMALIZE_MESSAGE_ID_FIELD]:
											config.normalizeAssistantMessageId,
									}
								: {}),
						};
						root[OPENAI_RESPONSES_COMPAT_SETTINGS_SECTION] = {
							...priorSection,
							[OPENAI_RESPONSES_COMPAT_GROUP]: nextValues,
						};
					},
					context.signal,
				);
			},
		},
	};
}
