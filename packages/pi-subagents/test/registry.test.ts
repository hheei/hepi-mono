import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { EffectiveLaunchConfig, SubagentRecord } from "../src/domain.js";
import { assembleChildPrompt } from "../src/launch-spec.js";
import { createSubagentRegistry, SubagentRegistryError } from "../src/registry.js";

const PARENT_SESSION_ID = "01J7-parent";

async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagents-registry-"));
	try {
		return await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function launchConfig(subagentId: string, cwd: string): EffectiveLaunchConfig {
	return {
		subagentId,
		invocation: { command: "/usr/bin/node", args: ["/usr/lib/pi/cli.js"] },
		cwd,
		sessionId: `${subagentId}-session`,
		sessionDir: join(cwd, "sessions"),
		agent: {
			name: "worker",
			hidden: false,
			sourcePath: join(cwd, ".pi", "agents", "worker.md"),
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

function record(
	subagentId: string,
	cwd: string,
	overrides: Partial<SubagentRecord> = {},
): SubagentRecord {
	const timestamp = new Date(0).toISOString();
	return {
		subagentId,
		parentSessionId: PARENT_SESSION_ID,
		revision: 1,
		createdAt: timestamp,
		updatedAt: timestamp,
		sessionId: `${subagentId}-session`,
		cwd,
		initialTask: "Do the work.",
		intent: "active",
		state: "starting",
		mode: "rpc",
		persistence: "never_flushed",
		launchConfig: launchConfig(subagentId, cwd),
		unacknowledgedInput: "Do the work.",
		...overrides,
	};
}

function registry(filePath: string) {
	return createSubagentRegistry({
		parentSessionId: PARENT_SESSION_ID,
		filePath,
		now: () => new Date(1_000),
	});
}

test("creates, reads, and lists records in a dedicated file", async (): Promise<void> => {
	await withDirectory(async (directory) => {
		const path = join(directory, "registry.json");
		const store = registry(path);
		await store.create(record("sa_aaaa", join(directory, "work")));

		expect(store.parentSessionId).toBe(PARENT_SESSION_ID);
		expect((await store.get("sa_aaaa"))?.sessionId).toBe("sa_aaaa-session");
		expect((await store.list()).map((item) => item.subagentId)).toEqual(["sa_aaaa"]);
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			version: 1,
			parentSessionId: PARENT_SESSION_ID,
		});
	});
});

test("keeps concurrent updates of different children from losing fields", async (): Promise<void> => {
	await withDirectory(async (directory) => {
		const path = join(directory, "registry.json");
		const first = registry(path);
		const second = registry(path);
		await first.create(record("sa_aaaa", join(directory, "a")));
		await first.create(record("sa_bbbb", join(directory, "b")));

		await Promise.all([
			first.update("sa_aaaa", 1, (current) => ({ ...current, state: "running" })),
			second.update("sa_bbbb", 1, (current) => ({
				...current,
				state: "idle",
				latestSummary: "done",
			})),
		]);

		const records = await first.list();
		expect(records.map((item) => [item.subagentId, item.state, item.revision])).toEqual([
			["sa_aaaa", "running", 2],
			["sa_bbbb", "idle", 2],
		]);
		expect(records[1]?.latestSummary).toBe("done");
	});
});

test("rejects stale revisions, duplicate ids, unknown children, and mismatched runtimes", async (): Promise<void> => {
	await withDirectory(async (directory) => {
		const path = join(directory, "registry.json");
		const store = registry(path);
		const cwd = join(directory, "work");
		await store.create(record("sa_aaaa", cwd));
		await store.update("sa_aaaa", 1, (current) => ({
			...current,
			state: "running",
			runtime: { runtimeIdentity: "runtime-2", endpoint: "/tmp/socket", pid: 42 },
		}));

		const cases: ReadonlyArray<{ readonly code: string; readonly run: () => Promise<unknown> }> = [
			{ code: "duplicate_child", run: () => store.create(record("sa_aaaa", cwd)) },
			{
				code: "stale_revision",
				run: () => store.update("sa_aaaa", 1, (current) => ({ ...current, state: "done" })),
			},
			{
				code: "unknown_child",
				run: () => store.update("sa_zzzz", 1, (current) => current),
			},
			{
				code: "runtime_mismatch",
				run: () => store.update("sa_aaaa", 2, (current) => current, "runtime-1"),
			},
		];
		for (const item of cases) {
			const error = await item.run().then(
				() => undefined,
				(thrown: unknown) => thrown,
			);
			expect(error).toBeInstanceOf(SubagentRegistryError);
			expect((error as SubagentRegistryError).code).toBe(item.code);
		}

		expect(await store.update("sa_aaaa", 2, (current) => current, "runtime-2")).toMatchObject({
			revision: 3,
			state: "running",
		});
	});
});

test("fails closed on corrupt JSON, unsupported versions, and foreign parent sessions", async (): Promise<void> => {
	await withDirectory(async (directory) => {
		const path = join(directory, "registry.json");
		const store = registry(path);
		await writeFile(path, "{not json", "utf8");
		await expect(store.list()).rejects.toThrow(/Invalid JSON/u);

		await writeFile(
			path,
			JSON.stringify({ version: 2, parentSessionId: PARENT_SESSION_ID }),
			"utf8",
		);
		const versionError = await store.list().then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
		expect((versionError as SubagentRegistryError).code).toBe("unsupported_version");

		await writeFile(path, JSON.stringify({ version: 1, parentSessionId: "someone-else" }), "utf8");
		const parentError = await store.list().then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
		expect((parentError as SubagentRegistryError).code).toBe("parent_mismatch");

		await writeFile(
			path,
			JSON.stringify({ version: 1, parentSessionId: PARENT_SESSION_ID }),
			"utf8",
		);
		await expect(store.list()).rejects.toThrow(/records must be an object/u);
	});
});

test("refuses records with unknown fields, secrets, or inconsistent session state", async (): Promise<void> => {
	await withDirectory(async (directory) => {
		const path = join(directory, "registry.json");
		const store = registry(path);
		const cwd = join(directory, "work");

		const cases: ReadonlyArray<{ readonly candidate: unknown; readonly reason: RegExp }> = [
			{
				candidate: { ...record("sa_aaaa", cwd), token: "secret" },
				reason: /unsupported field token/u,
			},
			{
				candidate: {
					...record("sa_aaaa", cwd),
					runtime: { runtimeIdentity: "r1", endpoint: "/tmp/s", token: "secret" },
				},
				reason: /runtime has unsupported field token/u,
			},
			{
				candidate: { ...record("sa_aaaa", cwd), parentSessionId: "01J7-other" },
				reason: /belongs to another parent session/u,
			},
			{
				candidate: { ...record("sa_aaaa", cwd), persistence: "flushed" },
				reason: /flushed session without a matching path/u,
			},
			{
				candidate: {
					...record("sa_aaaa", cwd),
					persistence: "never_flushed",
					sessionPath: join(cwd, "session.jsonl"),
				},
				reason: /never-flushed session with a session path/u,
			},
			{
				candidate: { ...record("sa_aaaa", cwd), sessionId: "different-session" },
				reason: /sessionId disagrees with its launch config/u,
			},
			{
				candidate: { ...record("sa_aaaa", cwd), state: "finishing" },
				reason: /state is invalid/u,
			},
			{
				candidate: {
					...record("sa_aaaa", cwd),
					launchConfig: {
						...launchConfig("sa_aaaa", cwd),
						extensions: { discovery: false, paths: ["/other.js"] },
					},
				},
				reason: /bridgeExtensionPath is missing/u,
			},
		];
		for (const item of cases) {
			await expect(store.create(item.candidate as SubagentRecord)).rejects.toThrow(item.reason);
		}
		expect(await store.list()).toEqual([]);
	});
});

test("rejects an invalid parent session id before touching the filesystem", async (): Promise<void> => {
	await withDirectory(async (directory) => {
		expect(() =>
			createSubagentRegistry({ parentSessionId: "../escape", filePath: join(directory, "r.json") }),
		).toThrow(/Invalid parent session id/u);
	});
});

test("drops foreign root keys while keeping every record", async (): Promise<void> => {
	await withDirectory(async (directory) => {
		const path = join(directory, "registry.json");
		const store = registry(path);
		await store.create(record("sa_aaaa", join(directory, "work")));
		await store.create(record("sa_bbbb", join(directory, "work")));
		const stray = JSON.parse(await readFile(path, "utf8"));
		await writeFile(path, JSON.stringify({ ...stray, legacySection: { enabled: true } }), "utf8");

		await store.update("sa_aaaa", 1, (current) => ({ ...current, state: "running" }));

		const written = JSON.parse(await readFile(path, "utf8"));
		expect(Object.keys(written).sort()).toEqual([
			"parentSessionId",
			"records",
			"updatedAt",
			"version",
		]);
		expect(Object.keys(written.records).sort()).toEqual(["sa_aaaa", "sa_bbbb"]);
		expect(written.updatedAt).toBe(new Date(1_000).toISOString());
	});
});

test("serializes runtime claims and consumes a reconnect token once", async (): Promise<void> => {
	await withDirectory(async (directory) => {
		const path = join(directory, "registry.json");
		const store = registry(path);
		const child = record("sa_claim", join(directory, "work"), {
			runtime: { runtimeIdentity: "runtime-1", endpoint: "/tmp/runner.sock", pid: 123 },
		});
		await store.create(child);
		const base = {
			kind: "reconnect" as const,
			holderPid: process.pid,
			runtimeIdentity: "runtime-1",
			endpoint: "/tmp/runner.sock",
			createdAt: new Date(0).toISOString(),
		};
		const claims = [
			{
				...base,
				claimId: "claim-a",
				holderIdentity: "holder-a",
				controllerTokenHash: "a".repeat(64),
			},
			{
				...base,
				claimId: "claim-b",
				holderIdentity: "holder-b",
				controllerTokenHash: "b".repeat(64),
			},
		];

		const outcomes = await Promise.allSettled(
			claims.map((claim) => store.claim("sa_claim", 1, claim, "runtime-1")),
		);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
		const winner = (await store.get("sa_claim"))?.claim;
		if (winner === undefined) throw new Error("claim winner missing");
		await expect(
			store.consumeReconnectClaim("sa_claim", winner.claimId, "f".repeat(64)),
		).rejects.toMatchObject({ code: "claim_mismatch" });
		await store.consumeReconnectClaim("sa_claim", winner.claimId, winner.controllerTokenHash);
		expect((await store.get("sa_claim"))?.claim).toBeUndefined();
	});
});
