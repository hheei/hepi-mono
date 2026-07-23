import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
	HePiContext,
	HePiSettingField,
	HePiSettingsProvider,
	HePiSettingsState,
	HePiSettingsStorage,
} from "../../api/settings.js";

export const AUTO_TITLE_GROUP = "auto-title";
export const AUTO_TITLE_FIELD = "autoTitle";
export const AUTO_TITLE_MODEL_FIELD = "autoTitleModel";
const SECTION = "pi-basics";
const MAX_PROMPT = 2000;
const TIMEOUT_MS = 60_000;

type JsonObject = Record<string, unknown>;
export interface AutoTitleStorageOptions {
	readonly path?: string;
}

export interface AutoTitleModelOption {
	readonly value: string;
	readonly label: string;
}

export interface AutoTitleCoordinator {
	trigger(force?: boolean): void;
	setModel(modelRef: string): void;
	dispose(): void;
}

async function readRoot(path: string): Promise<JsonObject> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}`, { cause: error });
	}
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Expected JSON object root in ${path}`);
	const section = (value as JsonObject)[SECTION];
	if (
		section !== undefined &&
		(section === null || typeof section !== "object" || Array.isArray(section))
	)
		throw new Error(`Expected ${SECTION} to be an object in ${path}`);
	return value as JsonObject;
}
async function writeRoot(path: string, root: JsonObject): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		await writeFile(tmp, `${JSON.stringify(root, null, 2)}\n`, "utf8");
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
}

export function createAutoTitleStorage(options: AutoTitleStorageOptions = {}): HePiSettingsStorage {
	const path = options.path;
	return {
		async load(ctx: { cwd?: string }): Promise<HePiSettingsState | undefined> {
			const root = await readRoot(path ?? join(ctx.cwd ?? process.cwd(), ".pi", "settings.json"));
			const section = root[SECTION];
			const values =
				section && typeof section === "object" && !Array.isArray(section)
					? (section as JsonObject)[AUTO_TITLE_GROUP]
					: undefined;
			if (!values || typeof values !== "object" || Array.isArray(values)) return undefined;
			return {
				[AUTO_TITLE_GROUP]: Object.fromEntries(
					Object.entries(values).filter(
						([, value]) =>
							value === null ||
							typeof value === "boolean" ||
							typeof value === "number" ||
							typeof value === "string",
					),
				),
			};
		},
		async save(state: HePiSettingsState, ctx: { cwd?: string }): Promise<void> {
			const target = path ?? join(ctx.cwd ?? process.cwd(), ".pi", "settings.json");
			const root = await readRoot(target);
			const prior = root[SECTION];
			const section: JsonObject =
				prior && typeof prior === "object" && !Array.isArray(prior)
					? { ...(prior as JsonObject) }
					: {};
			section[AUTO_TITLE_GROUP] = { ...(state[AUTO_TITLE_GROUP] ?? {}) };
			root[SECTION] = section;
			await writeRoot(target, root);
		},
	};
}

export function parseModelRef(value: string): { provider: string; model: string } {
	const split = value.trim().split("/");
	if (split.length !== 2 || !split[0] || !split[1] || split.some((part) => part.includes("\\")))
		throw new Error("Model must be exact provider/model");
	return { provider: split[0], model: split[1] };
}

export function autoTitleModelOptions(
	models: Iterable<{ readonly provider: string; readonly id: string; readonly name?: string }>,
): readonly AutoTitleModelOption[] {
	const unique = new Map<string, { readonly value: string; readonly label: string }>();
	for (const model of models) {
		const value = `${model.provider}/${model.id}`;
		unique.set(value, { value, label: model.name ?? value });
	}
	return [
		{ value: "", label: "Not set" },
		...[...unique.values()].sort((a, b) => a.value.localeCompare(b.value)),
	];
}

function autoTitleFields(
	modelOptions: readonly { readonly value: string; readonly label: string }[],
): readonly HePiSettingField[] {
	return [
		{
			id: AUTO_TITLE_FIELD,
			label: "auto title",
			type: "boolean",
			defaultValue: false,
			description: "Generate one short title after the first settled turn.",
			parse: (draft) => {
				if (draft === "true") return true;
				if (draft === "false") return false;
				throw new Error("Expected true or false");
			},
		},
		{
			id: AUTO_TITLE_MODEL_FIELD,
			label: "title model",
			type: "enum",
			defaultValue: "",
			description: "Choose the model used for title generation.",
			options: modelOptions,
			format: (value) =>
				modelOptions.find((option) => option.value === value)?.label ?? String(value),
			parse: (draft) => draft,
			enabled: () => true,
			validate: (value) => {
				if (!value) return undefined;
				if (typeof value !== "string") return "Expected provider/model string";
				try {
					parseModelRef(value);
					return undefined;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			},
		},
	];
}

export interface AutoTitleSettingsOptions {
	readonly path?: string;
	readonly modelOptions?: readonly { readonly value: string; readonly label: string }[];
	readonly validate?: (value: string, ctx: HePiContext) => Promise<void> | void;
	readonly prepareEnable?: (model?: string) => Promise<void> | void;
	readonly onPersisted?: (model: string | undefined) => Promise<void> | void;
}
export function createAutoTitleSettingsProvider(
	options: AutoTitleSettingsOptions = {},
): HePiSettingsProvider {
	const backingStorage = createAutoTitleStorage(
		options.path === undefined ? {} : { path: options.path },
	);
	const storage = {
		load: backingStorage.load,
		save: async (state: HePiSettingsState, ctx: HePiContext) => {
			await backingStorage.save(state, ctx);
			const values = state[AUTO_TITLE_GROUP] ?? {};
			const model = values[AUTO_TITLE_MODEL_FIELD];
			await options.onPersisted?.(
				values[AUTO_TITLE_FIELD] === true && typeof model === "string" && model ? model : undefined,
			);
		},
	};
	return {
		id: SECTION,
		title: "Pi Basics",
		origin: "@pi-basics",
		groups: [
			{
				id: AUTO_TITLE_GROUP,
				title: "",
				fields: autoTitleFields(options.modelOptions ?? [{ value: "", label: "Not set" }]),
			},
		],
		storage,
		onLoad: async (state, ctx) => {
			const values = state[AUTO_TITLE_GROUP] ?? {};
			const model = values[AUTO_TITLE_MODEL_FIELD];
			if (values[AUTO_TITLE_FIELD] !== true) return;
			if (typeof model === "string" && model) {
				parseModelRef(model);
				await options.validate?.(model, ctx);
			}
			await options.onPersisted?.(typeof model === "string" && model ? model : undefined);
		},
		onChange: async (change, ctx) => {
			if (change.fieldId !== AUTO_TITLE_FIELD && change.fieldId !== AUTO_TITLE_MODEL_FIELD) return;
			const values = change.state[AUTO_TITLE_GROUP] ?? {};
			const enabled = values[AUTO_TITLE_FIELD] === true;
			const model =
				typeof values[AUTO_TITLE_MODEL_FIELD] === "string" ? values[AUTO_TITLE_MODEL_FIELD] : "";
			if (!enabled) return;
			if (model) {
				parseModelRef(model);
				await options.validate?.(model, ctx);
			}
			if (change.fieldId === AUTO_TITLE_FIELD && change.value === true)
				await options.prepareEnable?.(model || undefined);
		},
	};
}

export interface AutoTitleRuntime {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
}
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

function safeTitle(value: string): string | undefined {
	let cleaned = "";
	for (const character of value.replace(ANSI_ESCAPE, "")) {
		const code = character.codePointAt(0) ?? 0;
		if (
			code <= 0x1f ||
			(code >= 0x7f && code <= 0x9f) ||
			(code >= 0x200b && code <= 0x200f) ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2060 && code <= 0x2064) ||
			code === 0xfeff
		)
			continue;
		cleaned += character;
	}
	const title = cleaned
		.replace(/```[\s\S]*?```/g, "")
		.replace(/[\r\n]+/g, " ")
		.replace(/^[\s"'`]+|[\s"'`]+$/g, "")
		.replace(/\s+/g, " ")
		.slice(0, 80)
		.trim();
	return title || undefined;
}
function latestUserText(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user") continue;
		const content = Array.isArray(message.content)
			? message.content
					.map((part) =>
						typeof part === "object" &&
						part !== null &&
						"text" in part &&
						typeof part.text === "string"
							? part.text
							: "",
					)
					.join(" ")
			: String(message.content ?? "");
		return content.slice(-MAX_PROMPT);
	}
	return undefined;
}

export interface AutoTitleAgentAdapter {
	prompt(prompt: string): Promise<void>;
	abort(): void;
	waitForIdle(): Promise<void>;
	result(): string | undefined;
}

export type AutoTitleAgentFactory = (
	runtime: AutoTitleRuntime,
	modelRef: string,
) => AutoTitleAgentAdapter;

export function createCoreAutoTitleAgent(
	runtime: AutoTitleRuntime,
	modelRef: string,
): AutoTitleAgentAdapter {
	const { provider, model: modelId } = parseModelRef(modelRef);
	const model = runtime.ctx.modelRegistry.find(provider, modelId);
	if (!model || !runtime.ctx.modelRegistry.hasConfiguredAuth(model))
		throw new Error(`Unavailable title model: ${modelRef}`);
	const agent = new Agent({
		sessionId: `pi-basics-auto-title:${runtime.ctx.sessionManager.getSessionId()}`,
		initialState: {
			systemPrompt:
				"Return only one short, descriptive title for this session. No more than 5 words. No quotes, markdown, or explanation.",
			model,
			thinkingLevel: "off",
			tools: [],
		},
		convertToLlm,
		getApiKey: (providerName) => runtime.ctx.modelRegistry.getApiKeyForProvider(providerName),
	});
	return {
		prompt: async (prompt) => {
			await agent.prompt(prompt);
		},
		abort: () => agent.abort(),
		waitForIdle: async () => {
			await agent.waitForIdle();
		},
		result: () => {
			for (let index = agent.state.messages.length - 1; index >= 0; index--) {
				const message = agent.state.messages[index];
				if (message?.role !== "assistant") continue;
				if (message.stopReason !== "stop" && message.stopReason !== "toolUse") return undefined;
				return message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join(" ");
			}
			return undefined;
		},
	};
}

export function createAutoTitleCoordinator(
	runtime: AutoTitleRuntime,
	initialModelRef: string,
	createAgent: AutoTitleAgentFactory = createCoreAutoTitleAgent,
): AutoTitleCoordinator {
	const { pi, ctx } = runtime;
	let modelRef = initialModelRef;
	let disposed = false;
	let revision = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let attempted = ctx.sessionManager
		.getEntries()
		.some((entry) => entry.type === "custom" && entry.customType === "pi-basics-auto-title");
	let launchRequested = false;
	let activeAgent: AutoTitleAgentAdapter | undefined;
	const setStatus = (text?: string) => ctx.ui?.setStatus?.("auto-title", text);
	const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let statusTimer: ReturnType<typeof setInterval> | undefined;
	const clearStatus = () => {
		if (statusTimer !== undefined) clearInterval(statusTimer);
		statusTimer = undefined;
		setStatus(undefined);
	};
	const startStatus = () => {
		clearStatus();
		let frame = 0;
		const update = () => {
			setStatus(`${spinnerFrames[frame++ % spinnerFrames.length]} Generating title...`);
		};
		update();
		statusTimer = setInterval(update, 120);
	};
	const stop = () => {
		clearTimeout(timer);
		timer = undefined;
		const agent = activeAgent;
		activeAgent = undefined;
		agent?.abort();
		if (agent) void agent.waitForIdle().catch(() => undefined);
	};
	const launch = () => {
		if (
			disposed ||
			!launchRequested ||
			activeAgent !== undefined ||
			attempted ||
			pi.getSessionName() ||
			!ctx.isIdle()
		)
			return;
		const prompt = latestUserText(ctx);
		if (!prompt) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionRevision = revision;
		let agent: AutoTitleAgentAdapter;
		try {
			agent = createAgent(runtime, modelRef);
		} catch (error) {
			ctx.ui.notify(
				`Unable to start automatic title: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
			return;
		}
		activeAgent = agent;
		attempted = true;
		pi.appendEntry("pi-basics-auto-title", { attempted: true });
		startStatus();
		let timedOut = false;
		timer = setTimeout(() => {
			timedOut = true;
			agent.abort();
		}, TIMEOUT_MS);
		void (async () => {
			try {
				await agent.prompt(prompt);
				await agent.waitForIdle();
				if (
					disposed ||
					activeAgent !== agent ||
					sessionId !== ctx.sessionManager.getSessionId() ||
					sessionRevision !== revision ||
					pi.getSessionName()
				)
					return;
				const title = safeTitle(agent.result() ?? "");
				if (title) pi.setSessionName(title);
			} catch (error) {
				if (!disposed && activeAgent === agent && sessionRevision === revision)
					ctx.ui.notify(
						timedOut
							? "Automatic title generation timed out"
							: `Automatic title generation failed: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
			} finally {
				if (activeAgent === agent) {
					activeAgent = undefined;
					clearTimeout(timer);
					timer = undefined;
					clearStatus();
				}
			}
		})();
	};
	const lifecycleUnsubs =
		typeof pi.on === "function"
			? []
			: [
					pi.events.on("session_info_changed", (event) => {
						revision++;
						if (event && typeof event === "object" && "name" in event && event.name) {
							clearStatus();
							stop();
						}
					}),
					pi.events.on("before_agent_start", () => {
						revision++;
						clearStatus();
						stop();
					}),
					pi.events.on("agent_settled", launch),
				];
	if (typeof pi.on === "function") {
		pi.on("session_info_changed", (event) => {
			revision++;
			if (event.name) {
				clearStatus();
				stop();
			}
		});
		pi.on("before_agent_start", () => {
			revision++;
			clearStatus();
			stop();
		});
		pi.on("agent_settled", launch);
	}
	return {
		trigger: (force = false) => {
			if (disposed) return;
			launchRequested = true;
			if (force) attempted = false;
			launch();
		},
		setModel: (nextModelRef: string) => {
			if (disposed || nextModelRef === modelRef) return;
			modelRef = nextModelRef;
			revision++;
			attempted = false;
			clearStatus();
			stop();
		},
		dispose: () => {
			disposed = true;
			revision++;
			clearStatus();
			for (const off of lifecycleUnsubs) off();
			stop();
		},
	};
}
