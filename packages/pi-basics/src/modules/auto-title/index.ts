import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	HePiContext,
	HePiSettingField,
	HePiSettingsProvider,
	HePiSettingsState,
} from "../../api/settings.js";

export const AUTO_TITLE_GROUP = "auto-title";
export const AUTO_TITLE_FIELD = "autoTitle";
export const AUTO_TITLE_MODEL_FIELD = "autoTitleModel";
const SECTION = "pi-basics";
const AGENT_PATH = [".pi", "agents", "pi-basics-auto-title.md"] as const;
const MAX_PROMPT = 2000;
const TIMEOUT_MS = 60_000;

type JsonObject = Record<string, unknown>;
export interface AutoTitleStorageOptions {
	readonly path?: string;
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

export function createAutoTitleStorage(options: AutoTitleStorageOptions = {}) {
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
) {
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
	const backingStorage = createAutoTitleStorage({ path: options.path });
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
interface RpcReply {
	success?: boolean;
	data?: unknown;
	error?: string;
}
interface Spawned {
	id: string;
	requestId: string;
}
const reply = (channel: string, id: string) => `${channel}:reply:${id}`;
export function requireAutoTitleSubagents(pi: ExtensionAPI, timeoutMs = 2_000): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const requestId = randomUUID();
	let settled = false;
	let timer: ReturnType<typeof setTimeout>;
	let offReply: () => void = () => undefined;
	let offReady: () => void = () => undefined;
	const finish = (error?: Error) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		offReply();
		offReady();
		if (error) reject(error);
		else resolve();
	};
	const off = pi.events.on(reply("subagents:rpc:ping", requestId), (data) => {
		const response = data as RpcReply;
		const version =
			response.data && typeof response.data === "object" && "version" in response.data
				? response.data.version
				: undefined;
		if (response.success !== true || version !== 2)
			return finish(new Error("pi-subagents RPC v2 is unavailable"));
		finish();
	});
	offReply = off;
	const ping = () => pi.events.emit("subagents:rpc:ping", { requestId });
	offReady = pi.events.on("subagents:ready", ping);
	timer = setTimeout(() => finish(new Error("pi-subagents is unavailable")), timeoutMs);
	ping();
	return promise;
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

export function createAutoTitleCoordinator(runtime: AutoTitleRuntime, initialModelRef: string) {
	const { pi, ctx } = runtime;
	let modelRef = initialModelRef;
	let disposed = false;
	let revision = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let attempted = ctx.sessionManager
		.getEntries()
		.some((e) => e.type === "custom" && e.customType === "pi-basics-auto-title");
	let launchRequested = false;
	let spawned: Spawned | undefined;
	const rpcUnsubs: Array<() => void> = [];
	const clear = () => {
		clearTimeout(timer);
		timer = undefined;
		for (const off of rpcUnsubs.splice(0)) off();
	};
	const stop = () => {
		const run = spawned;
		spawned = undefined;
		if (!run) return;
		const stopId = randomUUID();
		const channel = reply("subagents:rpc:stop", stopId);
		const off = pi.events.on(channel, () => off());
		pi.events.emit("subagents:rpc:stop", { requestId: stopId, agentId: run.id });
		setTimeout(off, 1000);
	};
	const launch = () => {
		if (disposed || !launchRequested || attempted || pi.getSessionName() || !ctx.isIdle()) return;
		const prompt = latestUserText(ctx);
		if (!prompt) return;
		attempted = true;
		pi.appendEntry("pi-basics-auto-title", { attempted: true });
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionRevision = revision;
		const pingId = randomUUID();
		const spawnId = randomUUID();
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clear();
			stop();
		};
		timer = setTimeout(finish, TIMEOUT_MS);
		const onPing = (data: unknown) => {
			const r = data as RpcReply;
			const version =
				r.data && typeof r.data === "object" && "version" in r.data ? r.data.version : undefined;
			if (done || r.success !== true || version !== 2) return;
			pi.events.emit("subagents:rpc:spawn", {
				requestId: spawnId,
				type: "pi-basics-auto-title",
				prompt,
				options: {
					description: "Generate session title",
					model: modelRef,
					maxTurns: 1,
					isolated: true,
					thinkingLevel: "off",
				},
			});
		};
		const onSpawn = (data: unknown) => {
			const r = data as RpcReply;
			const id =
				r.data && typeof r.data === "object" && "id" in r.data && typeof r.data.id === "string"
					? r.data.id
					: undefined;
			if (done || r.success !== true || !id) return;
			spawned = { id, requestId: spawnId };
			const onCompleted = (event: unknown) => {
				const e = event as { id?: unknown; status?: unknown; result?: unknown };
				if (
					e.id !== id ||
					(e.status !== "completed" && e.status !== "steered") ||
					typeof e.result !== "string" ||
					done ||
					disposed ||
					sessionId !== ctx.sessionManager.getSessionId() ||
					sessionRevision !== revision ||
					pi.getSessionName()
				)
					return;
				const title = safeTitle(e.result);
				if (title) pi.setSessionName(title);
				finish();
			};
			const onFailed = (event: unknown) => {
				if ((event as { id?: unknown }).id === id) finish();
			};
			rpcUnsubs.push(
				pi.events.on("subagents:completed", onCompleted),
				pi.events.on("subagents:failed", onFailed),
			);
		};
		rpcUnsubs.push(
			pi.events.on(reply("subagents:rpc:ping", pingId), onPing),
			pi.events.on(reply("subagents:rpc:spawn", spawnId), onSpawn),
		);
		pi.events.emit("subagents:rpc:ping", { requestId: pingId });
	};
	const lifecycleUnsubs =
		typeof pi.on === "function"
			? []
			: [
					pi.events.on("session_info_changed", (event) => {
						revision++;
						if (event && typeof event === "object" && "name" in event && event.name) {
							clear();
							stop();
						}
					}),
					pi.events.on("before_agent_start", () => {
						revision++;
						clear();
						stop();
					}),
					pi.events.on("agent_settled", launch),
				];
	if (typeof pi.on === "function") {
		pi.on("session_info_changed", (event) => {
			revision++;
			if (event.name) {
				clear();
				stop();
			}
		});
		pi.on("before_agent_start", () => {
			revision++;
			clear();
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
			clear();
			stop();
		},
		dispose: () => {
			disposed = true;
			revision++;
			clear();
			for (const off of lifecycleUnsubs) off();
			stop();
		},
	};
}

export async function provisionAutoTitleAgent(cwd: string): Promise<void> {
	const path = join(cwd, ...AGENT_PATH);
	try {
		await readFile(path);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		`---\nname: pi-basics-auto-title\ndescription: Generate one short session title\ntools: none\nextensions: false\nskills: false\npromptMode: replace\n---\nReturn only one short, descriptive title for this session. No more than 5 words. No quotes, markdown, or explanation.\n`,
		"utf8",
	);
}
