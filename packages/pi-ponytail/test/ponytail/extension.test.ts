import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import piPonytailExtension, { injectSubagentPrompt } from "../../src/index.js";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type Completions = (prefix: string) => ReadonlyArray<{
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}> | null;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type InputHandler = (
	event: { readonly text: string; readonly source: "interactive" | "rpc" | "extension" },
	ctx: ExtensionContext,
) => unknown;
type ToolCallHandler = (
	event: { readonly toolName: string; readonly input: unknown },
	ctx: ExtensionContext,
) => unknown;
type BeforeHandler = (
	event: { readonly systemPrompt: string; readonly prompt: string },
	ctx: ExtensionContext,
) => { readonly systemPrompt: string } | undefined;

interface Harness {
	readonly pi: ExtensionAPI;
	readonly commands: string[];
	readonly appended: Array<{ readonly customType: string; readonly data: unknown }>;
	command: CommandHandler | undefined;
	completions: Completions | undefined;
	sessionStart: Handler | undefined;
	sessionTree: Handler | undefined;
	sessionShutdown: Handler | undefined;
	input: InputHandler | undefined;
	toolCall: ToolCallHandler | undefined;
	beforeAgentStart: BeforeHandler | undefined;
}

const temporaryDirectories: string[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0))
		await harness.sessionShutdown?.({}, {} as ExtensionContext);
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function createHarness(
	options: { readonly sessionName?: string; readonly tools?: readonly string[] } = {},
): Harness {
	const harness: Harness = {
		commands: [],
		appended: [],
		command: undefined,
		completions: undefined,
		sessionStart: undefined,
		sessionTree: undefined,
		sessionShutdown: undefined,
		input: undefined,
		toolCall: undefined,
		beforeAgentStart: undefined,
		pi: undefined as unknown as ExtensionAPI,
	};
	const pi = {
		registerCommand(name: string, commandOptions: unknown) {
			harness.commands.push(name);
			const value = commandOptions as {
				handler: CommandHandler;
				getArgumentCompletions: Completions;
			};
			harness.command = value.handler;
			harness.completions = value.getArgumentCompletions;
		},
		on(event: string, handler: unknown) {
			switch (event) {
				case "session_start":
					harness.sessionStart = handler as Handler;
					break;
				case "session_tree":
					harness.sessionTree = handler as Handler;
					break;
				case "session_shutdown":
					harness.sessionShutdown = handler as Handler;
					break;
				case "input":
					harness.input = handler as InputHandler;
					break;
				case "tool_call":
					harness.toolCall = handler as ToolCallHandler;
					break;
				case "before_agent_start":
					harness.beforeAgentStart = handler as BeforeHandler;
					break;
			}
		},
		events: { emit() {}, on: () => () => {} },
		appendEntry(customType: string, data: unknown) {
			harness.appended.push({ customType, data });
		},
		getSessionName: () => options.sessionName,
		getAllTools: () => (options.tools ?? ["Agent"]).map((name) => ({ name })),
	} as unknown as ExtensionAPI;
	Object.assign(harness, { pi });
	harnesses.push(harness);
	return harness;
}

function createContext(branch: ReadonlyArray<unknown> = [], cwd = process.cwd()) {
	const statuses: Array<string | undefined> = [];
	const notifications: Array<{ readonly message: string; readonly level?: string }> = [];
	const ctx = {
		cwd,
		sessionManager: { getBranch: () => branch },
		ui: {
			setStatus: (_id: string, value: string | undefined) => statuses.push(value),
			notify: (message: string, level?: string) =>
				notifications.push(level === undefined ? { message } : { message, level }),
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, statuses, notifications };
}

async function createProject(settings: unknown): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-ponytail-extension-"));
	temporaryDirectories.push(cwd);
	await mkdir(join(cwd, ".pi"));
	await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
	return cwd;
}

describe("pi-ponytail extension", () => {
	test("registers only /ponytail with runtime-mode autocomplete", async () => {
		const harness = createHarness();
		await piPonytailExtension(harness.pi);
		expect(harness.commands).toEqual(["ponytail"]);
		expect(harness.completions?.("ult")).toEqual([
			{
				value: "ultra",
				label: "ultra",
				description: "Apply the strictest deletion-first and minimum-code guidance.",
			},
		]);
		expect(harness.completions?.("review")).toBeNull();
	});

	test("restores branch state, injects instructions, and persists changes", async () => {
		const cwd = await createProject({
			"pi-ponytail": { defaults: { mainMode: "full", subagentMode: "full" } },
		});
		const harness = createHarness();
		await piPonytailExtension(harness.pi, {
			settingsFilePath: join(cwd, ".pi", "settings.json"),
		});
		const branch = [
			{ type: "custom", customType: "pi-ponytail-state", data: { version: 1, mode: "lite" } },
		];
		const { ctx, statuses, notifications } = createContext(branch, cwd);
		await harness.sessionStart?.({}, ctx);
		expect(statuses).toEqual([]);
		expect(
			harness.beforeAgentStart?.({ systemPrompt: "BASE", prompt: "task" }, ctx)?.systemPrompt,
		).toContain("Current level: lite");

		await harness.command?.("ultra", ctx);
		expect(harness.appended.at(-1)).toEqual({
			customType: "pi-ponytail-state",
			data: { version: 1, mode: "ultra" },
		});
		expect(notifications).toEqual([{ message: "※ Ponytail mode enabled: ultra." }]);
		await harness.sessionTree?.({}, ctx);
		expect(
			harness.beforeAgentStart?.({ systemPrompt: "BASE", prompt: "task" }, ctx)?.systemPrompt,
		).toContain("Current level: lite");
	});

	test("uses configured subagent mode and suppresses duplicate injection", async () => {
		const cwd = await createProject({
			"pi-ponytail": { defaults: { mainMode: "lite", subagentMode: "ultra" } },
		});
		const harness = createHarness({ sessionName: "Explore#deadbeef", tools: ["read"] });
		await piPonytailExtension(harness.pi, {
			settingsFilePath: join(cwd, ".pi", "settings.json"),
		});
		const { ctx } = createContext([], cwd);
		await harness.sessionStart?.({}, ctx);
		expect(
			harness.beforeAgentStart?.({ systemPrompt: "BASE", prompt: "task" }, ctx)?.systemPrompt,
		).toContain("Current level: ultra");
		expect(
			harness.beforeAgentStart?.(
				{ systemPrompt: "BASE", prompt: injectSubagentPrompt("task", "ultra") },
				ctx,
			),
		).toBeUndefined();
		expect(
			harness.beforeAgentStart?.(
				{ systemPrompt: "BASE", prompt: "task\n<pi-ponytail-subagent>" },
				ctx,
			)?.systemPrompt,
		).toContain("Current level: ultra");
	});

	test("injects subagent default into Agent prompts", async () => {
		const cwd = await createProject({
			"pi-ponytail": { defaults: { mainMode: "lite", subagentMode: "ultra" } },
		});
		const harness = createHarness();
		await piPonytailExtension(harness.pi, {
			settingsFilePath: join(cwd, ".pi", "settings.json"),
		});
		const { ctx } = createContext([], cwd);
		await harness.sessionStart?.({}, ctx);
		const input = { prompt: "Review the diff" };
		await harness.toolCall?.({ toolName: "Agent", input }, ctx);
		expect(input.prompt).toContain("<pi-ponytail-subagent>");
		expect(input.prompt).toContain("Current level: ultra");
	});

	test("shows no passive mode status or startup notification", async () => {
		const cwd = await createProject({ "pi-ponytail": { defaults: {} } });
		const harness = createHarness();
		await piPonytailExtension(harness.pi, {
			settingsFilePath: join(cwd, ".pi", "settings.json"),
		});
		const { ctx, statuses, notifications } = createContext([], cwd);
		await harness.sessionStart?.({}, ctx);
		expect(statuses).toEqual([]);
		expect(notifications).toEqual([]);
	});
});
