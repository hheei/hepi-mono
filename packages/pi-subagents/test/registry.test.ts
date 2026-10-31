import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import type { EffectiveLaunchConfig, SubagentRecord } from "../src/domain.js";
import { assembleChildPrompt } from "../src/launch-spec.js";
import { createSubagentRegistry, SubagentRegistryError } from "../src/registry.js";
import { withTempDir } from "./helpers/tmp-dir.js";

const PARENT_SESSION_ID = "01J7-parent";

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
		mcp: { enabled: true },
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
		state: "running",
		presentation: "background",
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
	await withTempDir("pi-subagents-registry-", async (directory) => {
		const path = join(directory, "registry.json");
		const store = registry(path);
		await store.create(record("sa_aaaa", join(directory, "work")));

		expect(store.parentSessionId).toBe(PARENT_SESSION_ID);
		expect((await store.get("sa_aaaa"))?.sessionId).toBe("sa_aaaa-session");
		expect((await store.list()).map((item) => item.subagentId)).toEqual(["sa_aaaa"]);
		expect(store.path).toBe(path);
	});
});

test("keeps concurrent updates of different children from losing fields", async (): Promise<void> => {
	await withTempDir("pi-subagents-registry-", async (directory) => {
		const path = join(directory, "registry.json");
		const first = registry(path);
		const second = registry(path);
		await first.create(record("sa_aaaa", join(directory, "a")));
		await first.create(record("sa_bbbb", join(directory, "b")));

		await Promise.all([
			first.update("sa_aaaa", (current) => ({ ...current, state: "running" })),
			second.update("sa_bbbb", (current) => ({
				...current,
				state: "done",
				latestSummary: "done",
			})),
		]);

		const records = await first.list();
		expect(records.map((item) => [item.subagentId, item.state, item.revision])).toEqual([
			["sa_aaaa", "running", 2],
			["sa_bbbb", "done", 2],
		]);
		expect(records[1]?.latestSummary).toBe("done");
	});
});

test("rejects duplicate ids, unknown children, and mismatched runtimes", async (): Promise<void> => {
	await withTempDir("pi-subagents-registry-", async (directory) => {
		const path = join(directory, "registry.json");
		const store = registry(path);
		const cwd = join(directory, "work");
		await store.create(record("sa_aaaa", cwd));
		await store.update("sa_aaaa", (current) => ({
			...current,
			state: "running",
			runtime: { runtimeIdentity: "runtime-2", endpoint: "/tmp/socket" },
		}));

		const cases: ReadonlyArray<{ readonly code: string; readonly run: () => Promise<unknown> }> = [
			{ code: "duplicate_child", run: () => store.create(record("sa_aaaa", cwd)) },
			{
				code: "unknown_child",
				run: () => store.update("sa_zzzz", (current) => current),
			},
			{
				code: "runtime_mismatch",
				run: () => store.update("sa_aaaa", (current) => current, "runtime-1"),
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

		expect(await store.update("sa_aaaa", (current) => current, "runtime-2")).toMatchObject({
			revision: 3,
			state: "running",
		});
	});
});

test("fails closed on a corrupt child row and hides other parents in the same file", async (): Promise<void> => {
	await withTempDir("pi-subagents-registry-", async (directory) => {
		const path = join(directory, "state.sqlite");
		const store = registry(path);
		const db = new DatabaseSync(path);
		db.prepare(
			"INSERT INTO children (parent_session_id, subagent_id, record) VALUES (?, ?, ?)",
		).run(PARENT_SESSION_ID, "sa_bad", "{not json");
		await expect(store.list()).rejects.toThrow();
		db.prepare("DELETE FROM children WHERE subagent_id = ?").run("sa_bad");
		db.prepare(
			"INSERT INTO children (parent_session_id, subagent_id, record) VALUES (?, ?, ?)",
		).run("someone-else", "sa_other", "{}");
		expect(await store.list()).toEqual([]);
	});
});

test("refuses records with unknown fields, secrets, or inconsistent session state", async (): Promise<void> => {
	await withTempDir("pi-subagents-registry-", async (directory) => {
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
				// A record from the attach era names its presentation `mode`, and the field means
				// something else now, so the user deletes it instead of this version guessing.
				candidate: ((): unknown => {
					const { presentation: _presentation, ...legacy } = record("sa_aaaa", cwd);
					return { ...legacy, mode: "tui" };
				})(),
				reason: /was written by an older version \(mode "tui"\); delete this record/u,
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
	await withTempDir("pi-subagents-registry-", async (directory) => {
		expect(() =>
			createSubagentRegistry({ parentSessionId: "../escape", filePath: join(directory, "r.json") }),
		).toThrow(/Invalid parent session id/u);
	});
});

test("keeps another parent's rows when this parent updates its own", async (): Promise<void> => {
	await withTempDir("pi-subagents-registry-", async (directory) => {
		const path = join(directory, "state.sqlite");
		const store = registry(path);
		await store.create(record("sa_aaaa", join(directory, "work")));
		await store.create(record("sa_bbbb", join(directory, "work")));
		const other = createSubagentRegistry({
			parentSessionId: "01J7-other",
			filePath: path,
			now: () => new Date(1_000),
		});
		await other.create(
			record("sa_cccc", join(directory, "work"), { parentSessionId: "01J7-other" }),
		);
		await store.update("sa_aaaa", (current) => ({ ...current, state: "running" }));
		expect((await store.list()).map((item) => item.subagentId)).toEqual(["sa_aaaa", "sa_bbbb"]);
		expect((await other.list()).map((item) => item.subagentId)).toEqual(["sa_cccc"]);
	});
});

test("round-trips the frozen spawn title and keeps an absent one absent", async (): Promise<void> => {
	await withTempDir("pi-subagents-registry-", async (directory) => {
		const path = join(directory, "registry.json");
		await registry(path).create(record("sa_aaaa", join(directory, "work")));
		expect((await registry(path).get("sa_aaaa"))?.launchConfig.title).toBeUndefined();

		const titled = record("sa_bbbb", join(directory, "work"));
		await registry(path).create({
			...titled,
			launchConfig: { ...titled.launchConfig, title: "OVITO properties editor" },
		});
		expect((await registry(path).get("sa_bbbb"))?.launchConfig.title).toBe(
			"OVITO properties editor",
		);
	});
});

test("applies an update with an undefined expected revision and guards a replaced runtime", async (): Promise<void> => {
	await withTempDir("pi-subagents-registry-", async (directory) => {
		const path = join(directory, "registry.json");
		const store = registry(path);
		const cwd = join(directory, "work");
		await store.create(record("sa_atomic", cwd));
		const updated = await store.update("sa_atomic", (current) => ({
			...current,
			state: "running",
			runtime: { runtimeIdentity: "runtime-atomic", endpoint: "/tmp/atomic.sock" },
		}));
		expect(updated.revision).toBe(2);
		expect(updated.runtime?.runtimeIdentity).toBe("runtime-atomic");

		// A stale writer naming the runtime it replaced must not overwrite the newer launch.
		await expect(
			store.update("sa_atomic", (current) => ({ ...current, state: "done" }), "runtime-old"),
		).rejects.toMatchObject({ code: "runtime_mismatch" });
		expect((await store.get("sa_atomic"))?.state).toBe("running");
	});
});
