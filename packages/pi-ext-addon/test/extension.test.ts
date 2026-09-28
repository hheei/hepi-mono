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
	const pi = {
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
		getSessionName: () => undefined,
		setSessionName: () => undefined,
		appendEntry: () => undefined,
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands };
}

async function emit(
	handlers: Map<string, Array<(event: unknown, context?: unknown) => void | Promise<void>>>,
	channel: string,
	event: unknown,
	context: ExtensionContext,
): Promise<void> {
	for (const handler of handlers.get(channel) ?? []) {
		await handler(event, context);
	}
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
		emit: (channel, event) => emit(handlers, channel, event, extension),
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

			await emit(handlers, "session_shutdown", {}, fakeExtension(dir));
			expect(registry.get("dollar-skill")).toBeUndefined();
			expect(registry.get("auto-title")).toBeUndefined();
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
});
