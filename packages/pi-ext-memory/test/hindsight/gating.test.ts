import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => mock.agentDir,
}));

import { HINDSIGHT_TOOL_NAMES } from "../../src/hindsight/tools.js";
import observationalMemory from "../../src/index.js";

interface Hooks {
	readonly names: string[];
	readonly registered: string[];
	readonly handlers: Map<string, (event: unknown, context: unknown) => unknown>;
}

function installExtension(): Hooks {
	const names: string[] = [];
	const registered: string[] = [];
	const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
	const pi = {
		on: (eventName: string, handler: (event: unknown, context: unknown) => unknown) => {
			names.push(eventName);
			handlers.set(eventName, handler);
			return () => {};
		},
		registerCommand: () => {},
		registerTool: (tool: { name: string }) => {
			registered.push(tool.name);
		},
		getActiveTools: () => [...registered],
		setActiveTools: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	observationalMemory(pi);
	return { names, registered, handlers };
}

async function startSession(hooks: Hooks, cwd: string): Promise<void> {
	const sessionContext = {
		cwd,
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => "session-1" },
	};
	await hooks.handlers.get("session_start")?.(undefined, sessionContext);
}

function hindsightTools(hooks: Hooks): string[] {
	return hooks.registered.filter((name) => name.startsWith("hindsight_"));
}

describe("hindsight opt-in gating", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = `${tmpdir()}/hindsight-gating-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mock.agentDir = agentDir;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("registers no Hindsight tool when the option is absent", async () => {
		const hooks = installExtension();
		await startSession(hooks, cwd);
		expect(hindsightTools(hooks)).toEqual([]);
		// The session-scoped memory tool is still registered: gating applies only to Hindsight.
		expect(hooks.registered).toContain("recall");
	});

	it("registers no Hindsight tool when the option is explicitly false", async () => {
		writeFileSync(
			join(agentDir, "ext_settings.json"),
			JSON.stringify({
				"pi-ext-memory": { hindsight: { enabled: false, apiUrl: "http://unused" } },
			}),
			"utf-8",
		);
		const hooks = installExtension();
		await startSession(hooks, cwd);
		expect(hindsightTools(hooks)).toEqual([]);
	});

	it("registers exactly the eight prefixed tools once enabled", async () => {
		writeFileSync(
			join(agentDir, "ext_settings.json"),
			JSON.stringify({
				"pi-ext-memory": { hindsight: { enabled: true, apiUrl: "http://hindsight.test:38888" } },
			}),
			"utf-8",
		);
		const hooks = installExtension();
		await startSession(hooks, cwd);
		expect(hindsightTools(hooks).sort()).toEqual([...HINDSIGHT_TOOL_NAMES].sort());
	});
});
