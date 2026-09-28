import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { EffectiveLaunchConfig, RuntimeClaim, SubagentRecord } from "../src/domain.js";
import { assembleChildPrompt } from "../src/launch-spec.js";
import { createSubagentRegistry } from "../src/registry.js";
import {
	createRuntimeTokenStore,
	isPidConfirmedDead,
	isRecordedRunnerConfirmedDead,
	launchDetachedRunner,
	recoverDetachedRunner,
} from "../src/runtime.js";
import { startFakeRunner } from "./helpers/runner-harness.js";

const children: Array<{ kill: (signal: NodeJS.Signals) => boolean }> = [];

afterEach(() => {
	for (const child of children.splice(0)) {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
});

function sleepProcess(env: NodeJS.ProcessEnv = {}): number {
	const child = spawn("sleep", ["30"], { env: { ...process.env, ...env }, stdio: "ignore" });
	children.push(child);
	if (child.pid === undefined) throw new Error("sleep process has no pid");
	return child.pid;
}

function launchConfig(subagentId: string, cwd: string): EffectiveLaunchConfig {
	return {
		subagentId,
		invocation: { command: process.execPath, args: ["-e", "process.exit(0)"] },
		cwd,
		sessionId: `${subagentId}-session`,
		sessionDir: join(cwd, "sessions"),
		agent: {
			name: "worker",
			hidden: false,
			sourcePath: join(cwd, "worker.md"),
			instructions: "Work.",
		},
		model: { provider: "test", id: "model", source: "parent" },
		thinking: { level: "off", source: "parent" },
		tools: ["contact_parent"],
		excludeTools: [],
		extensions: { discovery: false, paths: [join(cwd, "extension.js")] },
		skills: { discovery: false, paths: [] },
		prompt: assembleChildPrompt("Work."),
		bridgeExtensionPath: join(cwd, "extension.js"),
		interactive: false,
	};
}

function childRecord(
	parentSessionId: string,
	subagentId: string,
	cwd: string,
	overrides: Partial<SubagentRecord> = {},
): SubagentRecord {
	const timestamp = new Date(0).toISOString();
	return {
		subagentId,
		parentSessionId,
		revision: 1,
		createdAt: timestamp,
		updatedAt: timestamp,
		sessionId: `${subagentId}-session`,
		cwd,
		initialTask: "Work.",
		intent: "active",
		state: "idle",
		mode: "rpc",
		persistence: "never_flushed",
		launchConfig: launchConfig(subagentId, cwd),
		...overrides,
	};
}

function reconnectClaim(
	record: SubagentRecord,
	holderPid: number,
	runnerPid?: number,
): RuntimeClaim {
	return {
		claimId: "claim-existing",
		kind: "reconnect",
		holderPid,
		runtimeIdentity: record.runtime?.runtimeIdentity ?? "runtime-one",
		endpoint: record.runtime?.endpoint ?? "/tmp/missing.sock",
		controllerTokenHash: "a".repeat(64),
		...(runnerPid === undefined ? {} : { runnerPid }),
	};
}

test("treats a reused PID as a dead runner and a matching live PID as still ours", async () => {
	expect(isPidConfirmedDead(process.pid)).toBe(false);
	expect(isPidConfirmedDead(999_999_999)).toBe(true);

	const reused = sleepProcess();
	expect(
		await isRecordedRunnerConfirmedDead(
			childRecord("parent-one", "child-one", tmpdir(), {
				runtime: {
					runtimeIdentity: "runtime-one",
					endpoint: "/tmp/missing.sock",
					pid: reused,
				},
			}),
		),
	).toBe(true);

	const ours = sleepProcess({ PI_SUBAGENTS_RUNTIME_ID: "runtime-one" });
	expect(
		await isRecordedRunnerConfirmedDead(
			childRecord("parent-one", "child-one", tmpdir(), {
				runtime: {
					runtimeIdentity: "runtime-one",
					endpoint: "/tmp/missing.sock",
					pid: ours,
				},
			}),
		),
	).toBe(false);
});

test("reconnects a surviving runner without starting a replacement or replaying input", async () => {
	let authorize: (claimId: string, token: string) => Promise<boolean> = async () => false;
	const harness = await startFakeRunner({
		runnerOptions: {
			authorizeRecovery: (claimId, token) => authorize(claimId, token),
		},
	});
	const directory = await mkdtemp(join(tmpdir(), "pi-subagents-recover-"));
	const registry = createSubagentRegistry({
		parentSessionId: harness.identity.parentSessionId,
		filePath: join(directory, "registry.json"),
	});
	authorize = async (claimId, token) => {
		await registry.consumeReconnectClaim(
			harness.identity.subagentId,
			claimId,
			createHash("sha256").update(token).digest("hex"),
		);
		return true;
	};
	try {
		const runtime = {
			runtimeIdentity: harness.identity.runtimeIdentity,
			endpoint: harness.identity.endpoint,
			...(harness.child.pid === undefined ? {} : { pid: harness.child.pid }),
		};
		const record = await registry.create(
			childRecord(harness.identity.parentSessionId, harness.identity.subagentId, directory, {
				runtime,
			}),
		);
		const recovered = await recoverDetachedRunner({
			registry,
			record,
			tokens: createRuntimeTokenStore(),
		});
		try {
			await expect(recovered.request("get_state")).resolves.toMatchObject({
				sessionId: "fake-session",
			});
			expect(recovered.connected).toBe(true);
		} finally {
			recovered.close();
		}
	} finally {
		await harness.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});

test("releases the claim when the runner it spawned is confirmed gone", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagents-start-"));
	const registry = createSubagentRegistry({
		parentSessionId: "parent-one",
		filePath: join(directory, "registry.json"),
	});
	const controller = new AbortController();
	try {
		const record = await registry.create(
			childRecord("parent-one", "child-start", directory, {
				// The runner entry starts and the process it supervises exits at once, so the launch never
				// connects and the runner itself is gone by the time the failure is handled.
				launchConfig: {
					...launchConfig("child-start", directory),
					invocation: { command: process.execPath, args: ["-e", "process.exit(3)"] },
				},
			}),
		);
		const launch = launchDetachedRunner({
			registry,
			record,
			tokens: createRuntimeTokenStore(),
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 300);
		// The abort lands in the connect phase, so a process was spawned and the failure was handled
		// with that process as evidence rather than before the spawn.
		await expect(launch).rejects.toThrow(/abort/iu);

		// Nothing is running under the launch, so the claim must not outlive it: keeping it would make
		// the child unavailable for the rest of the session even though no process owns it.
		expect((await registry.get("child-start"))?.claim).toBeUndefined();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("refuses replacement while a holder or claimed runner is still live", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagents-claim-"));
	const registry = createSubagentRegistry({
		parentSessionId: "parent-one",
		filePath: join(directory, "registry.json"),
	});
	try {
		const liveHolder = await registry.create(
			childRecord("parent-one", "child-holder", directory, {
				runtime: {
					runtimeIdentity: "runtime-holder",
					endpoint: join(directory, "missing.sock"),
					pid: 999_999_999,
				},
				claim: reconnectClaim(
					childRecord("parent-one", "child-holder", directory, {
						runtime: {
							runtimeIdentity: "runtime-holder",
							endpoint: join(directory, "missing.sock"),
							pid: 999_999_999,
						},
					}),
					process.pid,
				),
			}),
		);
		await expect(
			recoverDetachedRunner({
				registry,
				record: liveHolder,
				tokens: createRuntimeTokenStore(),
			}),
		).rejects.toThrow(/already claimed by a live or unknown owner/u);

		const runnerPid = sleepProcess();
		const liveRunner = await registry.create(
			childRecord("parent-one", "child-runner", directory, {
				runtime: {
					runtimeIdentity: "runtime-runner",
					endpoint: join(directory, "also-missing.sock"),
					pid: 999_999_998,
				},
				claim: reconnectClaim(
					childRecord("parent-one", "child-runner", directory, {
						runtime: {
							runtimeIdentity: "runtime-runner",
							endpoint: join(directory, "also-missing.sock"),
							pid: 999_999_998,
						},
					}),
					999_999_999,
					runnerPid,
				),
			}),
		);
		await expect(
			recoverDetachedRunner({
				registry,
				record: liveRunner,
				tokens: createRuntimeTokenStore(),
			}),
		).rejects.toThrow(/live or unknown claimed runner/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("refuses replacement when a flushed session file is missing", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagents-flush-"));
	const registry = createSubagentRegistry({
		parentSessionId: "parent-one",
		filePath: join(directory, "registry.json"),
	});
	try {
		const sessionPath = join(directory, "gone.jsonl");
		const record = await registry.create(
			childRecord("parent-one", "child-flush", directory, {
				persistence: "flushed",
				sessionPath,
				launchConfig: {
					...launchConfig("child-flush", directory),
					sessionPath,
				},
			}),
		);
		await expect(
			recoverDetachedRunner({
				registry,
				record,
				tokens: createRuntimeTokenStore(),
			}),
		).rejects.toThrow(/Recorded session file is missing/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
