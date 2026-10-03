import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getRuntimeSettingsRegistry } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import piExtAddonExtension from "../src/extension.js";

function fakePi() {
	const handlers = new Map<
		string,
		Array<(event: unknown, context?: unknown) => void | Promise<void>>
	>();
	const commands = new Map<string, unknown>();
	const sentMessages: Array<{ msg: unknown; opts: unknown }> = [];
	const pi = {
		sendMessage: (msg: unknown, opts: unknown) => {
			sentMessages.push({ msg, opts });
		},
		on: (channel: string, handler: (event: unknown, context?: unknown) => void | Promise<void>) => {
			const list = handlers.get(channel) ?? [];
			list.push(handler);
			handlers.set(channel, list);
			return () => {
				const index = list.indexOf(handler);
				if (index >= 0) list.splice(index, 1);
			};
		},
		registerCommand: (name: string, config: unknown) => {
			commands.set(name, config);
		},
		getCommands: () => [],
		getActiveTools: () => [],
		getSessionName: () => undefined,
		setSessionName: () => undefined,
		appendEntry: () => undefined,
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands, sentMessages };
}

async function emit(
	handlers: Map<string, Array<(event: unknown, context?: unknown) => unknown | Promise<unknown>>>,
	channel: string,
	event: unknown,
	context: ExtensionContext,
): Promise<unknown> {
	let lastResult: unknown;
	for (const handler of handlers.get(channel) ?? []) {
		lastResult = await handler(event, context);
	}
	return lastResult;
}

interface FakeExtensionOptions {
	readonly entries?: unknown[];
	readonly idle?: boolean;
	readonly models?: readonly { readonly provider: string; readonly id: string }[];
	readonly statuses?: Array<readonly [string, string | undefined]>;
	readonly notices?: Array<readonly [string, string | undefined]>;
}

function fakeExtension(cwd: string, options: FakeExtensionOptions = {}): ExtensionContext {
	const models = options.models ?? [];
	return {
		sessionManager: { getSessionId: () => "s", getEntries: () => options.entries ?? [] },
		modelRegistry: {
			getAvailable: () => models,
			hasConfiguredAuth: () => models.length > 0,
			find: (provider: string, id: string) =>
				models.find((model) => model.provider === provider && model.id === id),
		},
		cwd,
		isIdle: () => options.idle ?? true,
		ui: {
			notify: (message: string, type?: string) => {
				options.notices?.push([message, type]);
			},
			setStatus: (key: string, text: string | undefined) => {
				options.statuses?.push([key, text]);
			},
			addAutocompleteProvider: () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => undefined,
		},
		mode: "tui",
		hasUI: true,
	} as unknown as ExtensionContext;
}

type HandlerMap = Map<string, Array<(event: unknown, context?: unknown) => void | Promise<void>>>;

interface AutoTitleHarness {
	readonly extension: ExtensionContext;
	readonly entries: unknown[];
	readonly statuses: Array<readonly [string, string | undefined]>;
	readonly notices: Array<readonly [string, string | undefined]>;
	readonly emit: (channel: string, event: unknown) => Promise<void>;
	readonly cleanup: () => void;
}

/** Runs the addon against a throwaway agent dir whose settings enable automatic titles. */
function autoTitleHarness(options: { readonly idle?: boolean } = {}): AutoTitleHarness {
	const dir = mkdtempSync(join(tmpdir(), "pi-ext-addon-title-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	writeFileSync(
		join(dir, "ext_settings.json"),
		JSON.stringify({ "auto-title": { autoTitle: true, autoTitleModel: "gm/title-model" } }),
		"utf8",
	);
	const { pi, handlers }: { pi: ExtensionAPI; handlers: HandlerMap } = fakePi();
	piExtAddonExtension(pi);
	const entries: unknown[] = [];
	const statuses: Array<readonly [string, string | undefined]> = [];
	const notices: Array<readonly [string, string | undefined]> = [];
	const extension = fakeExtension(dir, {
		entries,
		models: [{ provider: "gm", id: "title-model" }],
		statuses,
		notices,
		...(options.idle === undefined ? {} : { idle: options.idle }),
	});
	return {
		extension,
		entries,
		statuses,
		notices,
		emit: async (channel, event) => {
			await emit(handlers, channel, event, extension);
		},
		cleanup: () => {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("pi-ext-addon extension lifecycle", () => {
	test("registers addon settings providers and cleans up on shutdown", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ext-addon-ext-"));
		try {
			const { pi, handlers, commands } = fakePi();
			piExtAddonExtension(pi);

			expect(commands.has("auto-title")).toBe(true);
			expect(handlers.get("session_start")?.length).toBeGreaterThan(0);
			expect(handlers.get("session_shutdown")?.length).toBeGreaterThan(0);

			await emit(handlers, "session_start", { reason: "startup" }, fakeExtension(dir));

			const registry = getRuntimeSettingsRegistry(pi);
			expect(registry.get("dollar-skill")?.id).toBe("dollar-skill");
			expect(registry.get("auto-title")?.id).toBe("auto-title");
			expect(registry.get("batch-tool-rules")?.id).toBe("batch-tool-rules");

			await emit(handlers, "session_shutdown", {}, fakeExtension(dir));
			expect(registry.get("dollar-skill")).toBeUndefined();
			expect(registry.get("auto-title")).toBeUndefined();
			expect(registry.get("batch-tool-rules")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a startup session generates its title after the first settled turn", async () => {
		const harness = autoTitleHarness();
		try {
			// Pi emits session_start before this extension's own lifecycle start, so the request has to
			// survive that ordering; a session with no conversation yet has nothing to summarize.
			await harness.emit("session_start", { reason: "startup" });
			expect(harness.statuses).toEqual([]);

			harness.entries.push(
				{ type: "message", message: { role: "user", content: "Fix the flaky test" } },
				{ type: "message", message: { role: "assistant", content: "Found the race" } },
			);
			await harness.emit("agent_settled", {});
			expect(
				harness.statuses.some(
					([key, text]) => key === "auto-title" && text?.includes("generating title..."),
				),
			).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	test("a resumed session does not generate a title nobody asked for", async () => {
		const harness = autoTitleHarness();
		try {
			await harness.emit("session_start", { reason: "resume" });
			harness.entries.push(
				{ type: "message", message: { role: "user", content: "Continue the refactor" } },
				{ type: "message", message: { role: "assistant", content: "Continuing" } },
			);
			await harness.emit("agent_settled", {});
			expect(harness.statuses).toEqual([]);
			expect(harness.notices).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	test("before_agent_start injects batch tool rules prompt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ext-addon-batch-rules-"));
		try {
			const { pi, handlers } = fakePi();
			piExtAddonExtension(pi);
			await emit(handlers, "session_start", { reason: "startup" }, fakeExtension(dir));

			const sections: Record<string, string> = {};
			const event = { systemPromptOptions: { sections } };

			await emit(handlers, "before_agent_start", event, fakeExtension(dir));
			expect(sections.tool_execution_rules).toBeDefined();
			expect(sections.tool_execution_rules).toContain("<tool_execution_rules>");
			expect(sections.tool_execution_rules).toContain("Agent turns are extremely expensive.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("tool_result fires codemode guard reminder via sendMessage on 4th single-tool call for Gemini model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ext-addon-guard-"));
		try {
			const { pi, handlers, sentMessages } = fakePi();
			piExtAddonExtension(pi);
			const context = {
				...fakeExtension(dir),
				model: { id: "gemini-2.5-pro", provider: "google" } as unknown as ExtensionContext["model"],
			};

			const makeEvent = (i: number) => ({
				toolName: "codemode",
				details: { calls: [{ tool: "read" }] },
				content: [{ type: "text", text: `output ${i}` }],
			});

			// Calls 1 to 3: no reminder
			for (let i = 1; i <= 3; i++) {
				const res = await emit(handlers, "tool_result", makeEvent(i), context);
				expect(res).toBeUndefined();
			}
			expect(sentMessages).toHaveLength(0);

			// Call 4: reminder triggered via sendMessage, tool result content remains untouched
			const res4 = await emit(handlers, "tool_result", makeEvent(4), context);
			expect(res4).toBeUndefined();
			expect(sentMessages).toHaveLength(1);
			expect((sentMessages[0]?.msg as { content?: string })?.content).toContain(
				"<system-reminder>",
			);
			expect((sentMessages[0]?.msg as { content?: string })?.content).toContain(
				"4 consecutive `codemode` calls",
			);
			expect(sentMessages[0]?.opts).toEqual({ deliverAs: "steer" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
