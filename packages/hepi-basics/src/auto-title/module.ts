import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	createHePiModelSelectionField,
	createJsonSectionSettingsStorage,
	type HePiContext,
	type HePiModelSelectionOption,
	type HePiSettingField,
	type HePiSettingsProvider,
	type HePiSettingsState,
	type HePiSettingsStorage,
	hePiModelSelectionOptions,
} from "../core/index.js";

export const AUTO_TITLE_GROUP = "auto-title";
export const AUTO_TITLE_FIELD = "autoTitle";
export const AUTO_TITLE_MODEL_FIELD = "autoTitleModel";
const SECTION = "pi-basics";
const MAX_PROMPT = 6000;
const MAX_PRIMARY_REQUEST = 4000;
const MAX_SUPPORTING_TEXT = 1000;
const TIMEOUT_MS = 60_000;
export const AUTO_TITLE_SYSTEM_PROMPT = `Create a concise, searchable title for a coding session.

Requirements:
- Use the same language as the user's primary request.
- Prefer 2 to 6 words when the language uses spaces; always stay under 60 characters.
- Name the concrete task and subject: feature, bug, package, file, command, model, or error.
- Preserve exact package names, file names, commands, and code identifiers when useful.
- Summarize the user's intent. Do not describe the assistant's actions or completion status.
- Avoid generic titles such as "Coding help", "Fix bug", "Update code", or "New session".
- Use sentence case where applicable.

Return exactly one plain-text title. No quotes, markdown, labels, trailing punctuation, or explanation.`;

export interface AutoTitleStorageOptions {
	readonly path?: string;
	readonly group?: string;
}

export type AutoTitleModelOption = HePiModelSelectionOption;

export interface AutoTitleCoordinator {
	trigger(force?: boolean): void;
	setModel(modelRef: string): void;
	sessionInfoChanged(name: string | undefined): void;
	beforeAgentStart(): void;
	agentSettled(): void;
	dispose(): void;
}

export function createAutoTitleStorage(options: AutoTitleStorageOptions = {}): HePiSettingsStorage {
	return createJsonSectionSettingsStorage({
		...(options.path === undefined ? {} : { path: options.path }),
		section: SECTION,
		group: options.group ?? AUTO_TITLE_GROUP,
	});
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
	return hePiModelSelectionOptions(models);
}

function autoTitleFields(
	modelOptions: readonly AutoTitleModelOption[],
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
		createHePiModelSelectionField({
			id: AUTO_TITLE_MODEL_FIELD,
			label: "title model",
			description: "Choose the model used for title generation.",
			modelOptions,
			thinking: "off",
		}),
	];
}

export interface AutoTitleSettingsOptions {
	readonly path?: string;
	readonly modelOptions?: readonly AutoTitleModelOption[];
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

export function safeTitle(value: string): string | undefined {
	let cleaned = "";
	for (const character of value.replace(ANSI_ESCAPE, "")) {
		const code = character.codePointAt(0) ?? 0;
		if (
			(code <= 0x1f && code !== 0x0a && code !== 0x0d) ||
			(code >= 0x7f && code <= 0x9f) ||
			(code >= 0x200b && code <= 0x200f) ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2060 && code <= 0x2064) ||
			code === 0xfeff
		)
			continue;
		cleaned += character;
	}
	const firstLine = cleaned
		.replace(/^```[a-z0-9_-]*\s*/i, "")
		.replace(/```$/i, "")
		.split(/[\r\n]+/)
		.map((line) => line.trim())
		.find((line) => line !== "");
	if (firstLine === undefined) return undefined;
	const title = firstLine
		.replace(/^(title|session (?:name|title))\s*:\s*/i, "")
		.replace(/^[-*]\s*/, "")
		.replace(/[.?!:;,。！？：；，]+$/g, "")
		.replace(/^[\s"'`]+|[\s"'`]+$/g, "")
		.replace(/[.?!:;,。！？：；，]+$/g, "")
		.replace(/\s+/g, " ")
		.slice(0, 60)
		.trim();
	return title || undefined;
}
function messageText(content: unknown): string {
	const text = Array.isArray(content)
		? content
				.map((part) =>
					typeof part === "object" &&
					part !== null &&
					"type" in part &&
					part.type === "text" &&
					"text" in part &&
					typeof part.text === "string"
						? part.text
						: "",
				)
				.join(" ")
		: typeof content === "string"
			? content
			: "";
	return text.replace(/\s+/g, " ").trim();
}

function autoTitleDescription(ctx: ExtensionContext): string | undefined {
	const messages: Array<{ readonly role: "user" | "assistant"; readonly text: string }> = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = messageText(entry.message.content);
		if (text !== "") messages.push({ role, text });
	}
	const primaryIndex = messages.findIndex((message) => message.role === "user");
	if (primaryIndex < 0) return undefined;
	const primary = messages[primaryIndex];
	if (primary === undefined) return undefined;
	const firstResult = messages
		.slice(primaryIndex + 1)
		.find((message) => message.role === "assistant");
	let latestUser: (typeof messages)[number] | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "user") {
			latestUser = message;
			break;
		}
	}
	const sections = [`Primary user request:\n${primary.text.slice(0, MAX_PRIMARY_REQUEST)}`];
	if (firstResult !== undefined)
		sections.push(`First assistant result:\n${firstResult.text.slice(0, MAX_SUPPORTING_TEXT)}`);
	if (latestUser !== undefined && latestUser !== primary)
		sections.push(`Latest user clarification:\n${latestUser.text.slice(0, MAX_SUPPORTING_TEXT)}`);
	return sections.join("\n\n").slice(0, MAX_PROMPT);
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
			systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
			model,
			thinkingLevel: "off",
			tools: [],
		},
		convertToLlm,
		getApiKey: (providerName) => runtime.ctx.modelRegistry.getApiKeyForProvider(providerName),
		streamFn: streamSimple,
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
				if (
					message.stopReason !== "stop" &&
					message.stopReason !== "length" &&
					message.stopReason !== "toolUse"
				)
					return undefined;
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
	let forceRequested = false;
	let launchTimer: ReturnType<typeof setTimeout> | undefined;
	let activeAgent: AutoTitleAgentAdapter | undefined;
	const setStatus = (text?: string) =>
		ctx.ui?.setWidget?.("auto-title", text === undefined ? undefined : [text], {
			placement: "aboveEditor",
		});
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
		clearTimeout(launchTimer);
		timer = undefined;
		launchTimer = undefined;
		const agent = activeAgent;
		activeAgent = undefined;
		if (agent) attempted = false;
		agent?.abort();
		if (agent) void agent.waitForIdle().catch(() => undefined);
	};
	const scheduleForcedLaunch = () => {
		if (disposed || !forceRequested || launchTimer !== undefined) return;
		launchTimer = setTimeout(() => {
			launchTimer = undefined;
			launch();
		}, 50);
	};
	const launch = () => {
		if (
			disposed ||
			!launchRequested ||
			activeAgent !== undefined ||
			(!forceRequested && (attempted || pi.getSessionName()))
		)
			return;
		if (!ctx.isIdle()) {
			scheduleForcedLaunch();
			return;
		}
		const forced = forceRequested;
		const prompt = autoTitleDescription(ctx);
		if (!prompt) {
			if (forced) ctx.ui.notify("Unable to generate title: no conversation content", "warning");
			forceRequested = false;
			return;
		}
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionRevision = revision;
		let agent: AutoTitleAgentAdapter;
		try {
			agent = createAgent(runtime, modelRef);
		} catch (error) {
			forceRequested = false;
			ctx.ui.notify(
				`Unable to start automatic title: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
			return;
		}
		forceRequested = false;
		activeAgent = agent;
		attempted = true;
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
					(!forced && pi.getSessionName())
				)
					return;
				const title = safeTitle(agent.result() ?? "");
				if (!title) {
					attempted = false;
					ctx.ui.notify("Automatic title model returned no usable title", "warning");
					return;
				}
				pi.setSessionName(title);
				pi.appendEntry("pi-basics-auto-title", { completed: true });
			} catch (error) {
				if (!disposed && activeAgent === agent && sessionRevision === revision) {
					attempted = false;
					ctx.ui.notify(
						timedOut
							? "Automatic title generation timed out"
							: `Automatic title generation failed: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
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
	const sessionInfoChanged = (name: string | undefined): void => {
		revision++;
		if (name) {
			clearStatus();
			stop();
		}
	};
	const beforeAgentStart = (): void => {
		revision++;
		clearStatus();
		stop();
	};
	const lifecycleUnsubs =
		typeof pi.on === "function"
			? []
			: [
					pi.events.on("session_info_changed", (event) => {
						sessionInfoChanged(
							event &&
								typeof event === "object" &&
								"name" in event &&
								typeof event.name === "string"
								? event.name
								: undefined,
						);
					}),
					pi.events.on("before_agent_start", beforeAgentStart),
					pi.events.on("agent_settled", launch),
				];
	return {
		trigger: (force = false) => {
			if (disposed) return;
			launchRequested = true;
			if (force) {
				attempted = false;
				forceRequested = true;
			}
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
		sessionInfoChanged,
		beforeAgentStart,
		agentSettled: launch,
		dispose: () => {
			disposed = true;
			revision++;
			clearStatus();
			for (const off of lifecycleUnsubs) off();
			stop();
		},
	};
}
