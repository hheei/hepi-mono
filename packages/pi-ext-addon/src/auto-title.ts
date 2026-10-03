import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type CompletionSubagentHandle,
	clampThinkingLevel,
	createJsonSettingsStorage,
	createModelSelectionField,
	type ExtensionLifecycleContext,
	errorMessage,
	type ModelSelectionCandidate,
	type ModelSelectionOption,
	type ModelSelectionRegistry,
	type ModelThinkingLevel,
	type SettingField,
	type SettingsContext,
	type SettingsProvider,
	type SettingsStorage,
	startSubagent,
} from "@hheei/pi-ext-core";

export const AUTO_TITLE_GROUP = "auto-title";
export const AUTO_TITLE_FIELD = "autoTitle";
export const AUTO_TITLE_MODEL_FIELD = "autoTitleModel";
export const AUTO_TITLE_SETTINGS_PROVIDER_ID = "auto-title";
/** Branch entry marking that this session already had a title generated. */
export const AUTO_TITLE_ENTRY_TYPE = "auto-title";
const MAX_PROMPT = 6000;
const MAX_PRIMARY_REQUEST = 4000;
const MAX_SUPPORTING_TEXT = 1000;
const TIMEOUT_MS = 60_000;
export const TITLE_SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"] as const;
export const TITLE_GENERATION_TEXT = "generating title...";
export const TITLE_SPINNER_INTERVAL_MS = 120;
export const AUTO_TITLE_SYSTEM_PROMPT = `Create a concise, searchable title for a coding session.

Requirements:
- Use the same language as the user's primary request.
- Prefer 2 to 6 words when the language uses spaces; always stay under 60 characters.
- Name the concrete task and subject: feature, bug, package, file, command, model, or error.
- Preserve exact package names, file names, commands, and code identifiers when useful.
- Summarize the user's intent. Do not describe the assistant's actions or completion status.
- Avoid generic titles such as "Coding help", "Fix bug", "Update code", or "New session".
- Use sentence case where applicable.

Return exactly one JSON object: {"title":"..."}. No markdown, labels, other keys, or explanation.`;

export interface AutoTitleStorageOptions {
	readonly path?: string;
	readonly group?: string;
}

export type AutoTitleModelOption = ModelSelectionOption;

export interface AutoTitleCoordinator {
	/**
	 * Owns at most one title-generation job for the current session. `force` ignores
	 * the once-per-session guard, while disposal aborts the child and clears timers.
	 */
	trigger(force?: boolean): void;
	/** Changes the model for future jobs and invalidates the current generation. */
	setModel(modelRef: string): void;
	/** Invalidates work after Pi changes the session title or branch context. */
	sessionInfoChanged(name: string | undefined): void;
	/** Cancels title work before the host starts another agent turn. */
	beforeAgentStart(): void;
	/** Attempts a deferred launch after the host becomes idle. */
	agentSettled(): void;
	/** Idempotently aborts work and releases timers owned by this coordinator. */
	dispose(): void;
}

export function createAutoTitleStorage(options: AutoTitleStorageOptions = {}): SettingsStorage {
	return createJsonSettingsStorage({
		...(options.path === undefined ? {} : { path: options.path }),
		group: options.group ?? AUTO_TITLE_GROUP,
	});
}

export function parseModelRef(value: string): { provider: string; model: string } {
	const split = value.trim().split("/");
	if (split.length !== 2 || !split[0] || !split[1] || split.some((part) => part.includes("\\")))
		throw new Error("Model must be exact provider/model");
	return { provider: split[0], model: split[1] };
}

function resolveAutoTitleThinkingLevel(
	modelRef: string,
	modelRegistry?: ModelSelectionRegistry<ModelSelectionCandidate>,
): ModelThinkingLevel {
	if (!modelRef) return "off";
	try {
		const { provider, model: modelId } = parseModelRef(modelRef);
		const model = modelRegistry?.find?.(provider, modelId);
		if (model) return clampThinkingLevel(model as never, "off");
	} catch {
		// Ignore invalid or empty ref
	}
	return "off";
}

function autoTitleFields(
	modelOptions: readonly AutoTitleModelOption[],
	modelRegistry?: ModelSelectionRegistry<ModelSelectionCandidate>,
): readonly SettingField[] {
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
		createModelSelectionField({
			id: AUTO_TITLE_MODEL_FIELD,
			label: "title model",
			description: "Choose the model used for title generation.",
			modelOptions,
			thinking: (value) => resolveAutoTitleThinkingLevel(value, modelRegistry),
			enabled: (state) => state[AUTO_TITLE_GROUP]?.[AUTO_TITLE_FIELD] === true,
		}),
	];
}

export interface AutoTitleSettingsOptions {
	readonly path?: string;
	readonly modelOptions?: readonly AutoTitleModelOption[];
	readonly modelRegistry?: ModelSelectionRegistry<ModelSelectionCandidate>;
	readonly validate?: (value: string, ctx: SettingsContext) => Promise<void> | void;
	readonly prepareEnable?: (model?: string) => Promise<void> | void;
	readonly onSettingsChange?: (enabled: boolean, model: string) => Promise<void> | void;
}
export function createAutoTitleSettingsProvider(
	options: AutoTitleSettingsOptions = {},
): SettingsProvider {
	const backingStorage = createAutoTitleStorage(
		options.path === undefined ? {} : { path: options.path },
	);
	return {
		id: AUTO_TITLE_SETTINGS_PROVIDER_ID,
		title: "Auto session title",
		origin: "@hheei/pi-ext-addon",
		groups: [
			{
				id: AUTO_TITLE_GROUP,
				title: "",
				fields: autoTitleFields(
					options.modelOptions ?? [{ value: "", label: "Not set" }],
					options.modelRegistry,
				),
			},
		],
		storage: backingStorage,
		onLoad: async (state, ctx) => {
			const values = state[AUTO_TITLE_GROUP] ?? {};
			const model = values[AUTO_TITLE_MODEL_FIELD];
			if (values[AUTO_TITLE_FIELD] !== true) return;
			if (typeof model === "string" && model) {
				parseModelRef(model);
				await options.validate?.(model, ctx);
			}
		},
		onChange: async (change, ctx) => {
			if (change.fieldId !== AUTO_TITLE_FIELD && change.fieldId !== AUTO_TITLE_MODEL_FIELD) return;
			const values = change.state[AUTO_TITLE_GROUP] ?? {};
			const enabled = values[AUTO_TITLE_FIELD] === true;
			const model =
				typeof values[AUTO_TITLE_MODEL_FIELD] === "string" ? values[AUTO_TITLE_MODEL_FIELD] : "";
			if (!enabled) {
				await options.onSettingsChange?.(false, model);
				return;
			}
			if (model) {
				parseModelRef(model);
				await options.validate?.(model, ctx);
			}
			if (change.fieldId === AUTO_TITLE_FIELD && change.value === true)
				await options.prepareEnable?.(model || undefined);
			await options.onSettingsChange?.(true, model);
		},
	};
}

/** Pi host handles supplied by the extension entry; the coordinator never owns them. */
export interface AutoTitleRuntime {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly lifecycle?: ExtensionLifecycleContext;
}
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

function isTitleResponse(value: unknown): value is { readonly title: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entries = Object.entries(value);
	return entries.length === 1 && entries[0]?.[0] === "title" && typeof entries[0]?.[1] === "string";
}

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
	let response: unknown;
	try {
		response = JSON.parse(cleaned);
	} catch {
		return undefined;
	}
	if (!isTitleResponse(response) || /[\r\n]/.test(response.title)) return undefined;
	const title = response.title
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
	const entryCount =
		"getEntryCount" in ctx.sessionManager &&
		typeof (ctx.sessionManager as { getEntryCount?: () => number }).getEntryCount === "function"
			? (ctx.sessionManager as { getEntryCount: () => number }).getEntryCount()
			: undefined;
	if (entryCount === 0) return undefined;

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
	run(prompt: string): Promise<string | undefined>;
	abort(): void;
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
	let handle: CompletionSubagentHandle | undefined;
	return {
		run: async (prompt) => {
			if (runtime.lifecycle === undefined)
				throw new Error("Auto-title completion lifecycle unavailable");
			const thinkingLevel = clampThinkingLevel(model, "off");
			handle = startSubagent(runtime.lifecycle, {
				mode: "completion",
				model,
				prompt,
				systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
				thinkingLevel,
			});
			const result = await handle.result;
			if (result.status !== "completed")
				throw new Error(result.status === "failed" ? result.failure.message : result.status);
			return result.output;
		},
		abort: () => handle?.cancel(),
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
		.some((entry) => entry.type === "custom" && entry.customType === AUTO_TITLE_ENTRY_TYPE);
	let launchRequested = false;
	let forceRequested = false;
	let activeAgent: AutoTitleAgentAdapter | undefined;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let spinnerIndex = 0;

	const setStatus = (text?: string): void => ctx.ui.setStatus("auto-title", text);
	const clearStatus = (): void => {
		if (spinnerTimer !== undefined) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
		setStatus(undefined);
	};
	const formatStatus = (frame: string): string => {
		const theme = ctx.ui.theme;
		if (theme) {
			return `${theme.fg("accent", frame)} ${theme.fg("dim", TITLE_GENERATION_TEXT)}`;
		}
		return `${frame} ${TITLE_GENERATION_TEXT}`;
	};
	const startStatus = (): void => {
		clearStatus();
		spinnerIndex = 0;
		const tick = (): void => {
			const frame = TITLE_SPINNER_FRAMES[spinnerIndex % TITLE_SPINNER_FRAMES.length] ?? "✻";
			spinnerIndex++;
			setStatus(formatStatus(frame));
		};
		tick();
		spinnerTimer = setInterval(tick, TITLE_SPINNER_INTERVAL_MS);
		spinnerTimer.unref?.();
	};
	const stop = () => {
		clearTimeout(timer);
		timer = undefined;
		clearStatus();
		const agent = activeAgent;
		activeAgent = undefined;
		if (agent) attempted = false;
		agent?.abort();
	};
	// A revision snapshot guards the async completion against session switches,
	// model changes, and a newer forced request before it writes the title.
	const launch = () => {
		if (
			disposed ||
			!launchRequested ||
			activeAgent !== undefined ||
			(!forceRequested && (attempted || pi.getSessionName()))
		)
			return;
		if (!ctx.isIdle()) {
			// The host cancels title work when the next turn starts, so a request made during a turn waits
			// for that turn to settle. Staying quiet about it looked like the command did nothing.
			if (forceRequested)
				ctx.ui.notify("Title generation starts when the current turn finishes.", "info");
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
			ctx.ui.notify(`Unable to start automatic title: ${errorMessage(error)}`, "warning");
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
				const output = await agent.run(prompt);
				if (
					disposed ||
					activeAgent !== agent ||
					sessionId !== ctx.sessionManager.getSessionId() ||
					sessionRevision !== revision ||
					(!forced && pi.getSessionName())
				)
					return;
				const title = safeTitle(output ?? "");
				if (!title) {
					attempted = false;
					ctx.ui.notify("Automatic title model returned no usable title", "warning");
					return;
				}
				pi.setSessionName(title);
				pi.appendEntry(AUTO_TITLE_ENTRY_TYPE, { completed: true });
			} catch (error) {
				if (!disposed && activeAgent === agent && sessionRevision === revision) {
					attempted = false;
					ctx.ui.notify(
						timedOut
							? "Automatic title generation timed out"
							: `Automatic title generation failed: ${errorMessage(error)}`,
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
			stop();
		},
	};
}
