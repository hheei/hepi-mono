import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const { registerLoadoutResource } = vi.hoisted(() => ({
	registerLoadoutResource: vi.fn(() => vi.fn()),
}));
vi.mock("@hheei/pi-ext-core", async () => {
	const actual = await vi.importActual<typeof import("@hheei/pi-ext-core")>("@hheei/pi-ext-core");
	return { ...actual, registerLoadoutResource };
});
vi.mock("../src/custom-agents.js", () => ({
	loadCustomAgents: vi.fn(
		() =>
			new Map([
				[
					"reload-agent",
					{
						name: "reload-agent",
						description: "Reload test agent",
						model: "inherit",
						thinking: "off",
						source: "project",
					},
				],
			]),
	),
}));
vi.mock("../src/agent-runner.js", async () => {
	const actual =
		await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
	return { ...actual, runAgent: vi.fn() };
});

import subagentsExtension from "../src/index.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
type LifecycleHandler = (...args: unknown[]) => unknown;
interface ManagerRegistryEntry {
	disposed: boolean;
}
interface TestHost {
	pi: ExtensionAPI;
	lifecycle: Map<string, LifecycleHandler[]>;
}

function makePi() {
	const lifecycle = new Map<string, LifecycleHandler[]>();
	const pi = {
		registerMessageRenderer: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		on: vi.fn((event: string, handler: LifecycleHandler) =>
			lifecycle.set(event, [...(lifecycle.get(event) ?? []), handler]),
		),
		events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
	};
	return { pi: pi as unknown as ExtensionAPI, lifecycle };
}

async function emit(host: TestHost, event: string, ...args: unknown[]): Promise<void> {
	for (const handler of host.lifecycle.get(event) ?? []) await handler(...args);
}

function context() {
	return {
		hasUI: false,
		ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
		cwd: process.cwd(),
		model: undefined,
		modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
		sessionManager: { getSessionId: vi.fn(() => "reload-session"), getBranch: vi.fn(() => []) },
		getSystemPrompt: vi.fn(() => "parent"),
	} as unknown as ExtensionContext;
}

const globals = globalThis as unknown as Record<PropertyKey, unknown>;
const priorGlobal = globals[MANAGER_KEY];
afterEach(() => {
	if (priorGlobal === undefined) delete globals[MANAGER_KEY];
	else globals[MANAGER_KEY] = priorGlobal;
	vi.clearAllMocks();
});

function manager(): ManagerRegistryEntry {
	const value = globals[MANAGER_KEY];
	if (!value || typeof value !== "object" || !("disposed" in value)) {
		throw new Error("manager registry entry missing");
	}
	return value as ManagerRegistryEntry;
}

describe("Subagents manager registry reload", () => {
	it("hands ownership to replacement after cleanup and syncs Loadout once", async () => {
		delete globals[MANAGER_KEY];
		const host = makePi();

		subagentsExtension(host.pi);
		await emit(host, "session_start", undefined, context());
		const first = manager();
		expect(first).toBeDefined();
		expect(first.disposed).toBe(false);
		expect(registerLoadoutResource).toHaveBeenCalledTimes(4);

		subagentsExtension(host.pi);
		await emit(host, "session_start", undefined, context());
		const replacement = manager();

		expect(first.disposed).toBe(true);
		expect(replacement).not.toBe(first);
		expect(replacement.disposed).toBe(false);
		expect(registerLoadoutResource).toHaveBeenCalledTimes(8);

		await emit(host, "session_shutdown");
	});
});
