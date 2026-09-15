import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import magicContextPiExtension, { __test } from "../src/index";
import { MAGIC_CONTEXT_PI_SUBAGENT_ENV } from "../src/subagent-runner";

const originalEnv = {
	MAGIC_CONTEXT_PI_SUBAGENT: process.env.MAGIC_CONTEXT_PI_SUBAGENT,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	XDG_DATA_HOME: process.env.XDG_DATA_HOME,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

function restoreEnv() {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function isolateXdgEnv() {
	const root = mkdtempSync(join(tmpdir(), "magic-context-pi-index-test-"));
	process.env.XDG_CONFIG_HOME = join(root, "config");
	process.env.XDG_DATA_HOME = join(root, "data");
	delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
}

function writePiSettings(settings: Record<string, unknown>) {
	const agentDir = mkdtempSync(join(tmpdir(), "magic-context-pi-settings-"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ "pi-mctx": settings }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
}

function createCountingPi() {
	const events: string[] = [];
	const tools: string[] = [];
	const flags: string[] = [];
	const commands: string[] = [];
	const commandDefinitions = new Map<string, unknown>();
	const entryRenderers: string[] = [];
	const messageRenderers: string[] = [];
	const appendEntry = vi.fn(() => undefined);
	const sendMessage = vi.fn(() => undefined);
	const sendUserMessage = vi.fn(() => undefined);
	const pi = {
		on: vi.fn((event: string) => {
			events.push(event);
		}),
		registerTool: vi.fn((tool: { name?: string }) => {
			tools.push(tool.name ?? "<unnamed>");
		}),
		registerFlag: vi.fn((name: string) => {
			flags.push(name);
		}),
		registerCommand: vi.fn((name: string, command: unknown) => {
			commands.push(name);
			commandDefinitions.set(name, command);
		}),
		registerEntryRenderer: vi.fn((customType: string) => {
			entryRenderers.push(customType);
		}),
		registerMessageRenderer: vi.fn((customType: string) => {
			messageRenderers.push(customType);
		}),
		appendEntry,
		sendMessage,
		sendUserMessage,
	} as unknown as ExtensionAPI;
	return {
		pi,
		events,
		tools,
		flags,
		commands,
		commandDefinitions,
		entryRenderers,
		messageRenderers,
		appendEntry,
		sendMessage,
		sendUserMessage,
	};
}

afterEach(() => {
	restoreEnv();
	// Clear the process-global init latch so one test's full init does not
	// leak into the next (the latch lives on globalThis, not module state).
	__test.clearPiMagicContextActive();
	vi.unstubAllGlobals();
});

describe("Pi full extension subagent env guard", () => {
	it("no-ops before registering anything inside Magic Context Pi subagents", async () => {
		isolateXdgEnv();
		process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV] = "1";
		const registrations = createCountingPi();

		await magicContextPiExtension(registrations.pi);

		expect(registrations.events).toEqual([]);
		expect(registrations.tools).toEqual([]);
		expect(registrations.flags).toEqual([]);
		expect(registrations.commands).toEqual([]);
		expect(registrations.entryRenderers).toEqual([]);
		expect(registrations.messageRenderers).toEqual([]);
	});

	it("registers the full runtime when the subagent guard is absent", async () => {
		isolateXdgEnv();
		const registrations = createCountingPi();

		await magicContextPiExtension(registrations.pi);

		expect(registrations.events.length).toBeGreaterThan(0);
		expect(registrations.tools.length).toBeGreaterThan(0);
		expect(registrations.commands.length).toBeGreaterThan(0);
		expect(registrations.entryRenderers).toEqual([
			"magic-context:handoff-request",
			"magic-context:handoff-attempt",
			"ctx-status",
		]);
		expect(registrations.messageRenderers).toEqual([
			"magic-context:ctx-reduce-nudge",
			"magic-context:ceiling-nudge",
			"magic-context:handoff",
		]);
		expect(registrations.events).toContain("before_agent_start");
		expect(registrations.tools).toContain("mctx_search");
		expect(registrations.commands).toContain("ctx-status");
		// This path initializes and migrates a fresh SQLite database before registering
		// the complete extension. In a 2-CPU Bun 1.3.14 Linux container it took
		// 0.49-2.59s (0.38-0.74s for SQLite alone), while a loaded 2-core release runner
		// reached 7.67s. Keep enough headroom for that measured cold-start work.
	}, 15_000);

	it("registers disabled AgentMemory health without network or model dispatch", async () => {
		isolateXdgEnv();
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const registrations = createCountingPi();

		await magicContextPiExtension(registrations.pi);

		expect(registrations.commands).toContain("agentmemory-health");
		const healthCommand = registrations.commandDefinitions.get("agentmemory-health") as {
			handler: () => Promise<void>;
		};
		await healthCommand.handler();

		expect(registrations.appendEntry).toHaveBeenLastCalledWith(
			"ctx-status",
			expect.objectContaining({
				title: "/agentmemory-health",
				text: "agentmemory: disabled",
				level: "info",
			}),
		);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(registrations.sendMessage).not.toHaveBeenCalled();
		expect(registrations.sendUserMessage).not.toHaveBeenCalled();
	}, 15_000);

	it("keeps AgentMemory active without Window when both bridge and memory tools are enabled", async () => {
		isolateXdgEnv();
		writePiSettings({
			enabled: false,
			compactionEnabled: true,
			agentmemoryEnabled: true,
			agentmemoryUrl: "http://127.0.0.1:1",
			agentmemoryMemoryTools: true,
			agentmemoryRequireHttps: false,
		});
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const registrations = createCountingPi();

		await magicContextPiExtension(registrations.pi);

		expect(registrations.commands).toEqual(["ctx-status", "agentmemory-health"]);
		expect(registrations.entryRenderers).toEqual(["ctx-status"]);
		expect(registrations.events).toContain("context");
		expect(registrations.events).toContain("session_start");
		expect(registrations.events).toContain("before_agent_start");
		expect(registrations.events).toContain("agent_end");
		expect(registrations.events).toContain("tool_result");
		expect(registrations.events).toContain("session_shutdown");
		const statusCommand = registrations.commandDefinitions.get("ctx-status") as {
			handler: (
				args: string,
				ctx: { cwd: string; hasUI: boolean; sessionManager: { getSessionId: () => string } },
			) => Promise<void>;
		};
		await statusCommand.handler("", {
			hasUI: false,
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => "bridge-only-session" },
		});
		expect(registrations.appendEntry).toHaveBeenLastCalledWith(
			"ctx-status",
			expect.objectContaining({
				title: "/ctx-status",
				text: expect.stringContaining("Window: disabled"),
			}),
		);
		expect(registrations.tools).not.toContain("mctx_note");
		expect(registrations.tools).not.toContain("mctx_expand");
		expect(registrations.tools).not.toContain("mctx_reduce");
		expect(fetchSpy).not.toHaveBeenCalled();
	}, 15_000);

	it.each([
		false,
		true,
	])("reports an enabled but invalid bridge as unavailable (Window=%s)", async (enabled) => {
		isolateXdgEnv();
		writePiSettings({
			enabled,
			agentmemoryEnabled: true,
			agentmemoryUrl: "not-a-url",
			agentmemoryMemoryTools: true,
		});
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const registrations = createCountingPi();

		await magicContextPiExtension(registrations.pi);

		if (!enabled) {
			expect(registrations.tools).toEqual([]);
			expect(registrations.commands).toEqual(["ctx-status", "agentmemory-health"]);
		}
		const healthCommand = registrations.commandDefinitions.get("agentmemory-health") as {
			handler: () => Promise<void>;
		};
		await healthCommand.handler();
		expect(registrations.appendEntry).toHaveBeenLastCalledWith(
			"ctx-status",
			expect.objectContaining({
				title: "/agentmemory-health",
				text: expect.stringContaining("agentmemory unavailable:"),
				level: "error",
			}),
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	}, 15_000);

	it("registers nothing when both Window and AgentMemory are disabled", async () => {
		isolateXdgEnv();
		writePiSettings({ enabled: false, compactionEnabled: false, agentmemoryEnabled: false });
		const registrations = createCountingPi();

		await magicContextPiExtension(registrations.pi);

		expect(registrations.events).toEqual([]);
		expect(registrations.tools).toEqual([]);
		expect(registrations.commands).toEqual([]);
		expect(registrations.entryRenderers).toEqual([]);
		expect(registrations.messageRenderers).toEqual([]);
	}, 15_000);

	it("keeps Window active but omits reduce when compaction is disabled without AgentMemory", async () => {
		isolateXdgEnv();
		writePiSettings({ enabled: true, compactionEnabled: false, agentmemoryEnabled: false });
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const registrations = createCountingPi();

		await magicContextPiExtension(registrations.pi);

		expect(registrations.events).toContain("context");
		expect(registrations.tools).toContain("mctx_search");
		expect(registrations.tools).not.toContain("mctx_reduce");
		expect(registrations.commands).toContain("agentmemory-health");
		expect(fetchSpy).not.toHaveBeenCalled();
	}, 15_000);
});
