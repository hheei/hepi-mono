import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { EffectiveLaunchConfig, SubagentRecord } from "../src/domain.js";
import { BRIDGE_ENVIRONMENT_KEYS } from "../src/domain.js";
import type { HostAdapter, HostAttachment } from "../src/host-adapter.js";
import type { LaunchSpec } from "../src/launch-spec.js";
import { assembleChildPrompt } from "../src/launch-spec.js";
import { createSubagentRegistry } from "../src/registry.js";
import {
	createRuntimeTokenStore,
	launchChild,
	openChildPanel,
	parentBridgeEndpoint,
	parentTokenFile,
	prepareRuntimeDirectory,
} from "../src/runtime.js";
import { withTempDir } from "./helpers/tmp-dir.js";

const PARENT_SESSION_ID = "01J7-parent";

function launchConfig(subagentId: string, cwd: string): EffectiveLaunchConfig {
	return {
		subagentId,
		// A stand-in child: it holds stdin open exactly like a headless Pi and exits with the pipe.
		invocation: { command: process.execPath, args: ["-e", "process.stdin.resume()"] },
		cwd,
		sessionId: `${subagentId}-session`,
		sessionDir: join(cwd, "sessions"),
		agent: {
			name: "worker",
			hidden: false,
			sourcePath: join(cwd, "worker.md"),
			instructions: "Do the work.",
		},
		model: { provider: "anthropic", id: "claude-sonnet-4", source: "parent" },
		thinking: { level: "medium", source: "parent" },
		tools: ["contact_parent"],
		excludeTools: [],
		extensions: { discovery: false, paths: ["/pkg/dist/extension.js"] },
		skills: { discovery: true, paths: [] },
		prompt: assembleChildPrompt("Do the work."),
		bridgeExtensionPath: "/pkg/dist/extension.js",
	};
}

function record(id: string, cwd: string): SubagentRecord {
	const config = launchConfig(id, cwd);
	return {
		subagentId: id,
		parentSessionId: PARENT_SESSION_ID,
		revision: 1,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		sessionId: config.sessionId,
		cwd,
		initialTask: "Do the work.",
		intent: "active",
		state: "running",
		presentation: "background",
		persistence: "never_flushed",
		launchConfig: config,
	};
}

describe("parent bridge endpoint", () => {
	test("is a stable path per parent session in a private runtime directory", () => {
		const endpoint = parentBridgeEndpoint(PARENT_SESSION_ID);
		expect(endpoint.startsWith(tmpdir())).toBe(true);
		expect(endpoint).toContain(`pi-subagents-${process.getuid?.() ?? "user"}`);
		expect(endpoint.endsWith(`parent-${PARENT_SESSION_ID}.sock`)).toBe(true);
		expect(parentBridgeEndpoint("another")).not.toBe(endpoint);
	});

	test("creates the runtime directory", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			await expect(prepareRuntimeDirectory()).resolves.toContain("pi-subagents-");
			void directory;
		});
	});
});

describe("bridge token store", () => {
	test("keeps each parent session's tokens in its own file", () => {
		const first = parentTokenFile("parent-a");
		const second = parentTokenFile("parent-b");

		// Two parent sessions share the runtime directory; one shared file would be rewritten
		// wholesale by whichever parent saved last, locking the other's children out of the bridge.
		expect(first).not.toBe(second);
		expect(first).toContain("parent-a");
		expect(second).toContain("parent-b");
	});

	test("keeps tokens in memory and on disk so a restarted parent can authorize a child", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const file = join(directory, "tokens.json");
			const first = createRuntimeTokenStore({ parentSessionId: "parent-a", file });
			first.remember("runtime-1", "token-1");
			expect(first.get("runtime-1")).toBe("token-1");
			await vi.waitFor(async () => {
				expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ "runtime-1": "token-1" });
			});

			// A new process reading the same file authorizes the same child.
			const second = createRuntimeTokenStore({ parentSessionId: "parent-a", file });
			expect(second.get("runtime-1")).toBe("token-1");
			second.forget("runtime-1");
			expect(second.get("runtime-1")).toBeUndefined();
			await vi.waitFor(async () => {
				expect(JSON.parse(await readFile(file, "utf8"))).toEqual({});
			});
		});
	});

	test("reports a token file it cannot read instead of failing the session", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const file = join(directory, "tokens.json");
			await writeFile(file, "{not json");
			const diagnoses: string[] = [];
			const store = createRuntimeTokenStore({
				parentSessionId: "parent-a",
				file,
				diagnose: (message) => diagnoses.push(message),
			});
			expect(store.get("runtime-1")).toBeUndefined();
			expect(diagnoses[0]).toContain("not valid JSON");
			await rm(file);
		});
	});
});

describe("launching a child runtime", () => {
	test("spawns a headless child, records its runtime and waits for the bridge", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const registry = createSubagentRegistry({
				parentSessionId: PARENT_SESSION_ID,
				filePath: join(directory, "registry.json"),
			});
			await mkdir(join(directory, "work"), { recursive: true });
			const stored = await registry.create(record("sa_launch", join(directory, "work")));
			const file = join(directory, "tokens.json");
			const tokens = createRuntimeTokenStore({ parentSessionId: "parent-a", file });
			const waitForBridge = vi.fn(async () => true);

			const launched = await launchChild({
				registry,
				record: stored,
				tokens,
				waitForBridge,
			});
			const runtime = launched.handle;
			if (runtime === undefined) throw new Error(launched.failure);
			expect(runtime.pid).toBeGreaterThan(0);
			expect(runtime.alive).toBe(true);
			expect(waitForBridge).toHaveBeenCalledWith("sa_launch", undefined);

			const current = await registry.get("sa_launch");
			expect(current?.runtime?.endpoint).toBe(parentBridgeEndpoint(PARENT_SESSION_ID));
			expect(current?.runtime?.runtimeIdentity).toBeTruthy();
			expect(tokens.get(current?.runtime?.runtimeIdentity ?? "")).toBeTruthy();

			await runtime.terminate();
			await expect(runtime.exited).resolves.toBeDefined();
			expect(runtime.alive).toBe(false);
		});
	});

	test("ends a child that never connects instead of leaving it unreachable", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const registry = createSubagentRegistry({
				parentSessionId: PARENT_SESSION_ID,
				filePath: join(directory, "registry.json"),
			});
			await mkdir(join(directory, "work"), { recursive: true });
			const stored = await registry.create(record("sa_silent", join(directory, "work")));
			const tokens = createRuntimeTokenStore({
				parentSessionId: "parent-a",
				file: join(directory, "tokens.json"),
			});

			const launched = await launchChild({
				registry,
				record: stored,
				tokens,
				waitForBridge: async () => false,
			});
			expect(launched.failure).toMatch(/never connected to the parent bridge/);
			// The process did stop, so nothing is handed back for the caller to keep.
			expect(launched.handle).toBeUndefined();

			const current = await registry.get("sa_silent");
			// Confirmed cleanup leaves no runtime evidence that could block a safe retry.
			expect(current?.runtime).toBeUndefined();
			expect(tokens.get(current?.runtime?.runtimeIdentity ?? "")).toBeUndefined();
		});
	});
});

describe("opening a child in a host panel", () => {
	/** A host that records what it was asked to open and counts the panels it was asked to close. */
	function fakeHost(
		behavior: { readonly failOpen?: string; readonly refuseClose?: boolean } = {},
	): {
		readonly host: HostAdapter;
		readonly specs: LaunchSpec[];
		readonly cleanups: () => number;
	} {
		const specs: LaunchSpec[] = [];
		let cleanups = 0;
		const identity = {
			host: "herdr",
			attachmentId: "wG:tH",
			createdBy: PARENT_SESSION_ID,
		} as const;
		return {
			specs,
			cleanups: () => cleanups,
			host: {
				kind: "herdr",
				async probe() {
					return { host: "herdr", available: true, reason: "test host" };
				},
				async open(spec): Promise<HostAttachment> {
					specs.push(spec);
					if (behavior.failOpen !== undefined) throw new Error(behavior.failOpen);
					let alive = true;
					return {
						identity,
						launch: { stdout: "", stderr: "", exitCode: 0, timedOut: false },
						reportsFocus: true,
						async observe() {
							return { identity, alive, known: true, focused: false, detail: "" };
						},
						async cleanup() {
							cleanups += 1;
							if (behavior.refuseClose === true) {
								return { stdout: "", stderr: "close denied", exitCode: 1, timedOut: false };
							}
							alive = false;
							return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
						},
					};
				},
			},
		};
	}

	async function panelSetup(directory: string): Promise<{
		readonly registry: ReturnType<typeof createSubagentRegistry>;
		readonly tokens: ReturnType<typeof createRuntimeTokenStore>;
		readonly stored: SubagentRecord;
	}> {
		const registry = createSubagentRegistry({
			parentSessionId: PARENT_SESSION_ID,
			filePath: join(directory, "registry.json"),
		});
		await mkdir(join(directory, "work"), { recursive: true });
		const stored = await registry.create(record("sa_panel", join(directory, "work")));
		return {
			registry,
			tokens: createRuntimeTokenStore({
				parentSessionId: "parent-a",
				file: join(directory, "tokens.json"),
			}),
			stored,
		};
	}

	test("runs the same Pi argv as a background child, minus --mode, with the token in its env", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const { registry, tokens, stored } = await panelSetup(directory);
			const { host, specs } = fakeHost();
			const waitForBridge = vi.fn(async () => true);

			const opened = await openChildPanel({
				registry,
				record: stored,
				tokens,
				host,
				waitForBridge,
			});
			expect(opened.failure).toBeUndefined();
			const attachment = opened.handle;
			if (attachment === undefined) throw new Error("no panel was opened");
			expect(attachment.identity.attachmentId).toBe("wG:tH");
			expect(waitForBridge).toHaveBeenCalledWith("sa_panel", undefined);

			const spec = specs[0];
			expect(spec?.presentation).toBe("panel");
			expect(spec?.stdio).toBe("inherit");
			expect(spec?.argv).not.toContain("--mode");
			expect(spec?.env[BRIDGE_ENVIRONMENT_KEYS.endpoint]).toBe(
				parentBridgeEndpoint(PARENT_SESSION_ID),
			);
			const current = await registry.get("sa_panel");
			expect(current?.runtime?.runtimeIdentity).toBeTruthy();
			expect(tokens.get(current?.runtime?.runtimeIdentity ?? "")).toBe(
				spec?.env[BRIDGE_ENVIRONMENT_KEYS.token],
			);
		});
	});

	test("closes the panel and forgets the token when the child never connects", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const { registry, tokens, stored } = await panelSetup(directory);
			const { host, cleanups } = fakeHost();

			const opened = await openChildPanel({
				registry,
				record: stored,
				tokens,
				host,
				waitForBridge: async () => false,
			});
			expect(opened.failure).toMatch(/never connected to the parent bridge/);
			// The panel is closed and confirmed gone, so the caller holds nothing.
			expect(opened.handle).toBeUndefined();

			expect(cleanups()).toBe(1);
			const current = await registry.get("sa_panel");
			expect(current?.runtime).toBeUndefined();
			expect(tokens.get(current?.runtime?.runtimeIdentity ?? "")).toBeUndefined();
		});
	});

	test("hands back a panel it could not close so nothing starts a second runtime", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const { registry, tokens, stored } = await panelSetup(directory);
			const { host, cleanups } = fakeHost({ refuseClose: true });

			const opened = await openChildPanel({
				registry,
				record: stored,
				tokens,
				host,
				waitForBridge: async () => false,
			});
			expect(opened.failure).toMatch(/could not be closed/);
			expect(opened.handle?.identity.attachmentId).toBe("wG:tH");
			expect(cleanups()).toBe(1);
			// The token stays too: a child that does come up is adopted instead of becoming a process
			// nobody owns, and the handle is what keeps a second runtime from being started.
			const current = await registry.get("sa_panel");
			expect(tokens.get(current?.runtime?.runtimeIdentity ?? "")).toBeTruthy();
		});
	});

	test("keeps the token and reports an unconfirmed panel when the host cannot open one", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const { registry, tokens, stored } = await panelSetup(directory);
			const { host } = fakeHost({ failOpen: "herdr tab create failed" });

			// Opening is not atomic: the host can create the panel and then fail to report it, so the
			// launch is reported as unconfirmed and the credential is kept — a child that does come up
			// is adopted instead of becoming a process nobody can reach.
			const opened = await openChildPanel({
				registry,
				record: stored,
				tokens,
				host,
				waitForBridge: async () => true,
			});

			expect(opened.unconfirmed).toBe(true);
			expect(opened.failure).toMatch(/could not be opened in a herdr panel/);
			const current = await registry.get("sa_panel");
			expect(tokens.get(current?.runtime?.runtimeIdentity ?? "")).toBeTruthy();
		});
	});
});
