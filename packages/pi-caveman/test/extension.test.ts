import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import piCavemanExtension from "../src/index.js";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type Completions = (prefix: string) => ReadonlyArray<{
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}> | null;
type SessionHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type InputHandler = (
	event: { readonly text: string; readonly source: "interactive" | "rpc" | "extension" },
	ctx: ExtensionContext,
) => unknown;
type ToolCallHandler = (
	event: { readonly toolName: string; readonly input: unknown },
	ctx: ExtensionContext,
) => unknown;
type BeforeAgentStartHandler = (
	event: { readonly systemPrompt: string; readonly prompt: string },
	ctx: ExtensionContext,
) => { readonly systemPrompt: string } | undefined;

interface Harness {
	readonly pi: ExtensionAPI;
	readonly appended: Array<{ readonly customType: string; readonly data: unknown }>;
	command: CommandHandler | undefined;
	completions: Completions | undefined;
	sessionStart: SessionHandler | undefined;
	sessionTree: SessionHandler | undefined;
	sessionShutdown: SessionHandler | undefined;
	input: InputHandler | undefined;
	toolCall: ToolCallHandler | undefined;
	beforeAgentStart: BeforeAgentStartHandler | undefined;
}

interface HarnessOptions {
	readonly sessionName?: string;
	readonly toolNames?: readonly string[];
}

const temporaryDirectories: string[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0))
		await harness.sessionShutdown?.({}, {} as ExtensionContext);
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function createHarness(options: HarnessOptions = {}): Harness {
	const harness: Harness = {
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
		registerCommand(_name: string, commandOptions: unknown) {
			const command = commandOptions as {
				handler: CommandHandler;
				getArgumentCompletions: Completions;
			};
			harness.command = command.handler;
			harness.completions = command.getArgumentCompletions;
		},
		on(event: string, handler: unknown) {
			switch (event) {
				case "session_start":
					harness.sessionStart = handler as SessionHandler;
					break;
				case "session_tree":
					harness.sessionTree = handler as SessionHandler;
					break;
				case "session_shutdown":
					harness.sessionShutdown = handler as SessionHandler;
					break;
				case "input":
					harness.input = handler as InputHandler;
					break;
				case "tool_call":
					harness.toolCall = handler as ToolCallHandler;
					break;
				case "before_agent_start":
					harness.beforeAgentStart = handler as BeforeAgentStartHandler;
					break;
			}
		},
		events: { emit() {}, on: () => () => {} },
		appendEntry(customType: string, data: unknown) {
			harness.appended.push({ customType, data });
		},
		getSessionName: () => options.sessionName,
		getAllTools: () => (options.toolNames ?? ["Agent"]).map((name) => ({ name })),
	} as unknown as ExtensionAPI;
	Object.assign(harness, { pi });
	harnesses.push(harness);
	return harness;
}

function createContext(
	branch: ReadonlyArray<unknown> = [],
	cwd = process.cwd(),
): {
	readonly ctx: ExtensionCommandContext;
	readonly statuses: Array<string | undefined>;
	readonly notifications: Array<{ readonly message: string; readonly level?: string }>;
} {
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

async function createSettingsProject(mainMode: string, subagentMode: string): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-caveman-extension-"));
	temporaryDirectories.push(cwd);
	await mkdir(join(cwd, ".pi"));
	await writeFile(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({ "pi-caveman": { defaults: { mainMode, subagentMode } } }),
	);
	return cwd;
}

describe("pi-caveman extension", () => {
	test("provides canonical mode autocomplete", async () => {
		const harness = createHarness();
		await piCavemanExtension(harness.pi);

		expect(harness.completions?.("ult")).toEqual([
			{
				value: "ultra",
				label: "ultra",
				description: "Use the shortest Caveman response style with minimal prose.",
			},
		]);
		expect(harness.completions?.("wenyan-")?.map((item) => item.value)).toEqual([
			"wenyan-lite",
			"wenyan-full",
			"wenyan-ultra",
		]);
		expect(harness.completions?.("missing")).toBeNull();
	});

	test("restores state, injects prompt, and persists command changes", async () => {
		const harness = createHarness();
		await piCavemanExtension(harness.pi);
		const branch = [
			{ type: "custom", customType: "pi-caveman-state", data: { version: 1, mode: "lite" } },
		];
		const { ctx, statuses, notifications } = createContext(branch);

		await harness.sessionStart?.({}, ctx);
		expect(statuses).toEqual([]);
		expect(
			harness.beforeAgentStart?.({ systemPrompt: "BASE", prompt: "task" }, ctx)?.systemPrompt,
		).toContain("Current intensity: lite");

		await harness.command?.("ultra", ctx);
		expect(harness.appended.at(-1)).toEqual({
			customType: "pi-caveman-state",
			data: { version: 1, mode: "ultra" },
		});
		expect(notifications).toEqual([{ message: "※ Caveman mode enabled: ultra." }]);

		await harness.sessionTree?.({}, ctx);
		expect(
			harness.beforeAgentStart?.({ systemPrompt: "BASE", prompt: "task" }, ctx)?.systemPrompt,
		).toContain("Current intensity: lite");
	});

	test("natural-language deactivation removes prompt without showing status", async () => {
		const harness = createHarness();
		await piCavemanExtension(harness.pi);
		const { ctx, statuses } = createContext();
		await harness.sessionStart?.({}, ctx);

		harness.input?.({ text: "normal mode", source: "interactive" }, ctx);
		expect(
			harness.beforeAgentStart?.({ systemPrompt: "BASE", prompt: "task" }, ctx),
		).toBeUndefined();
		expect(statuses).toEqual([]);
		expect(harness.appended.at(-1)).toEqual({
			customType: "pi-caveman-state",
			data: { version: 1, mode: "off" },
		});
	});

	test("uses subagent default and avoids duplicate marker injection", async () => {
		const cwd = await createSettingsProject("lite", "ultra");
		const harness = createHarness({ sessionName: "Explore#deadbeef", toolNames: ["read"] });
		await piCavemanExtension(harness.pi);
		const { ctx } = createContext([], cwd);
		await harness.sessionStart?.({}, ctx);

		expect(
			harness.beforeAgentStart?.({ systemPrompt: "BASE", prompt: "task" }, ctx)?.systemPrompt,
		).toContain("Current intensity: ultra");
		expect(
			harness.beforeAgentStart?.(
				{ systemPrompt: "BASE", prompt: "task\n<pi-caveman-subagent>" },
				ctx,
			),
		).toBeUndefined();
	});

	test("injects configured mode into pi-subagents Agent tool prompts", async () => {
		const cwd = await createSettingsProject("lite", "wenyan-full");
		const harness = createHarness();
		await piCavemanExtension(harness.pi);
		const { ctx } = createContext([], cwd);
		await harness.sessionStart?.({}, ctx);
		const input = { prompt: "Review the diff" };

		await harness.toolCall?.({ toolName: "Agent", input }, ctx);
		expect(input.prompt).toContain("<pi-caveman-subagent>");
		expect(input.prompt).toContain("Current intensity: wenyan-full");
	});
});
