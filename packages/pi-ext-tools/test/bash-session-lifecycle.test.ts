import { rmSync } from "node:fs";
import {
	type ExtensionAPI,
	type ExtensionToolContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { registerBashTool } from "../src/bash.js";
import { BashJobRegistry } from "../src/bash-jobs.js";
import { bashExecutionDirectory } from "../src/bash-ledger.js";
import { registerBgBashTools } from "../src/bg-bash-tools.js";
import { createToolsRuntimeState, registerToolsLifecycle } from "../src/session-state.js";
import { toolFor, toolHost } from "./fixtures/harness.js";
import { ledgerTemporaryDirectory } from "./fixtures/ledger-directory.js";

interface Lifecycle {
	readonly tools: ReturnType<typeof toolHost>["tools"];
	readonly start: () => Promise<void>;
	readonly shutdown: () => Promise<void>;
	readonly warnings: string[];
	readonly context: ExtensionToolContext;
	readonly directory: string;
	readonly manager: SessionManager;
	readonly jobs: () => BashJobRegistry | undefined;
}

const open: Lifecycle[] = [];

afterEach(async () => {
	for (const current of open.splice(0)) {
		await current.shutdown();
		rmSync(current.directory, { recursive: true, force: true });
	}
});

/** One extension session: the lifecycle handlers Pi would call, over a real settings registry. */
function lifecycle(): Lifecycle {
	const directory = ledgerTemporaryDirectory("hepi-bash-lifecycle-");
	const host = toolHost();
	const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void> | void>();
	const warnings: string[] = [];
	const manager = SessionManager.create(process.cwd(), directory);
	const context = {
		sessionManager: manager,
		isIdle: () => true,
		ui: { notify: (message: string) => void warnings.push(message) },
		cwd: process.cwd(),
	} as unknown as ExtensionToolContext;
	const pi = {
		events: {},
		registerTool: host.pi.registerTool,
		getActiveTools: host.activeTools,
		setActiveTools: host.pi.setActiveTools,
		sendMessage: () => undefined,
		on(type: string, handler: (event: unknown, context: unknown) => Promise<void> | void) {
			handlers.set(type, handler);
			return () => {
				handlers.delete(type);
			};
		},
	} as unknown as ExtensionAPI;
	const state = createToolsRuntimeState();
	registerBgBashTools(pi, state);
	registerBashTool(pi, state);
	registerToolsLifecycle(pi, state);
	const fire = async (type: string): Promise<void> => {
		await handlers.get(type)?.({}, context);
	};
	const current: Lifecycle = {
		tools: host.tools,
		start: () => fire("session_start"),
		shutdown: () => fire("session_shutdown"),
		warnings,
		context,
		directory,
		manager,
		jobs: () => state.getBashJobs(),
	};
	open.push(current);
	return current;
}

test("a session start owns one Bash registry and teardown releases it", async () => {
	const current = lifecycle();
	await current.start();
	expect(current.warnings).toEqual([]);
	const spawn = toolFor(current.tools, "bg_bash_spawn");
	const started = await spawn.execute(
		"call",
		{ command: "sleep 30" },
		undefined,
		undefined,
		current.context,
	);
	expect(started).not.toMatchObject({ isError: true });

	// Teardown stops the owned process and waits for its exit before the session is gone.
	await current.shutdown();
	// A second shutdown and a second start stay harmless.
	await current.shutdown();
	await current.start();
});

test("a session restart restores reliable execution records and preserves their ID", async () => {
	const current = lifecycle();
	await current.start();
	const result = await toolFor(current.tools, "bg_bash_spawn").execute(
		"call",
		{ command: "printf lifecycle-output" },
		undefined,
		undefined,
		current.context,
	);
	const { id } = result.details as { id: string };
	expect(await current.jobs()?.waitFor(id)).toMatchObject({
		status: "completed",
		output: "lifecycle-output",
	});
	await current.shutdown();
	await current.start();
	expect(current.jobs()?.get(id)).toMatchObject({
		status: "completed",
		output: "lifecycle-output",
		exitCode: 0,
	});
});

test("real fork preserves history while isolating execution ownership and original-session recovery", async () => {
	const current = lifecycle();
	current.manager.appendMessage({
		role: "user",
		content: "start background build",
		timestamp: Date.now(),
	});
	await current.start();
	const result = await toolFor(current.tools, "bg_bash_spawn").execute(
		"spawn",
		{ command: "printf fork-output" },
		undefined,
		undefined,
		current.context,
	);
	const { id } = result.details as { id: string };
	expect(await current.jobs()?.waitFor(id)).toMatchObject({
		status: "completed",
		output: "fork-output",
	});
	const leaf = current.manager.appendCustomEntry("historical-bg-spawn", { id });
	const originalFile = current.manager.getSessionFile()!;
	const originalSession = current.manager.getSessionId();
	const originalDirectory = bashExecutionDirectory(current.context);
	const originalEntries = current.manager.getBranch().map((entry) => entry.id);
	await current.shutdown();
	current.manager.createBranchedSession(leaf);
	expect(current.manager.getSessionId()).not.toBe(originalSession);
	expect(current.manager.getBranch().map((entry) => entry.id)).toEqual(originalEntries);
	expect(bashExecutionDirectory(current.context)).not.toBe(originalDirectory);
	await current.start();
	expect(current.jobs()?.get(id)).toBeUndefined();
	expect(current.jobs()?.pendingDeliveries()).toEqual([]);
	for (const name of ["bg_bash_get", "bg_bash_stop"]) {
		await expect(
			toolFor(current.tools, name).execute(name, { id }, undefined, undefined, current.context),
		).rejects.toThrow("not found");
	}
	await current.shutdown();
	current.manager.setSessionFile(originalFile);
	await current.start();
	expect(current.manager.getSessionId()).toBe(originalSession);
	expect(current.jobs()?.get(id)).toMatchObject({
		status: "completed",
		output: "fork-output",
		exitCode: 0,
	});
});

test("teardown of an idle session registers and disposes a registry exactly once", async () => {
	const current = lifecycle();
	await current.start();
	await current.start();
	await current.shutdown();
	expect(current.warnings).toEqual([]);
});

test("a registry dispose is awaited, so shutdown never returns with a live tree", async () => {
	const jobs = new BashJobRegistry();
	const started = jobs.start({ command: "sleep 30", cwd: process.cwd(), background: true });
	expect(started.status).toBe("running");
	await jobs.dispose();
	// The process reported its exit before dispose resolved, so no record survives teardown.
	expect(jobs.get(started.id)).toBeUndefined();
	expect(jobs.pendingDeliveries()).toEqual([]);
});
