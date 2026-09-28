import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ThinkingLevel } from "../src/domain.js";
import { createSubagentRegistry } from "../src/registry.js";
import {
	findSessionFile,
	inspectSessionFile,
	persistSubagentIntent,
	planSessionPlacement,
	resolveSubagentLaunch,
} from "../src/session-bootstrap.js";
import { withTempDir } from "./helpers/tmp-dir.js";

const TASK_CONTRACT = { softTurns: 60 } as const;

const PARENT_SESSION_ID = "01J7-parent";
const PARENT = {
	model: { provider: "anthropic", id: "claude-sonnet-4" },
	thinking: "medium" as ThinkingLevel,
};
const MODEL_REGISTRY = {
	find: (provider: string, modelId: string): unknown | undefined =>
		`${provider}/${modelId}` === "anthropic/claude-sonnet-4"
			? { provider, id: modelId }
			: undefined,
};

async function writeAgent(cwd: string, body = "Do the work."): Promise<void> {
	const path = join(cwd, ".pi", "agents", "worker.md");
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, `---\nname: worker\n---\n${body}\n`, "utf8");
}

/** Pi resolves its agent dir from the environment, so tests never touch the host's sessions. */
let agentDir = "";

beforeAll(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-subagents-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterAll(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	await rm(agentDir, { recursive: true, force: true });
});

async function writeSessionFile(
	sessionDir: string,
	sessionId: string,
	cwd: string,
): Promise<string> {
	const path = join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
	await mkdir(sessionDir, { recursive: true });
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd,
	};
	await writeFile(path, `${JSON.stringify(header)}\n`, "utf8");
	return path;
}

test("resolves one launch configuration with ids, bridge, and parent-derived policy", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		await writeAgent(cwd);
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");

		const config = await resolveSubagentLaunch({
			input: { task: "Fix the failing test", agent: "worker" },
			cwd,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			invocation: { command: "/usr/bin/node", args: ["/usr/lib/pi/cli.js"] },
			bridgeExtensionPath: bridge,
		});

		expect(config.subagentId).toMatch(/^sa_[0-9a-f]{12}$/u);
		expect(config.cwd).toBe(cwd);
		expect(config.sessionPath).toBeUndefined();
		expect(config.sessionDir.startsWith(join(agentDir, "sessions"))).toBe(true);
		expect(config.extensions.paths).toEqual([bridge]);
		expect(config.prompt).toContain("Do the work.");
		expect(config.prompt).toContain("contact_parent");
		expect(config.interactive).toBe(false);
		expect(JSON.stringify(config)).not.toContain("PI_SUBAGENTS_TOKEN");
	});
});

test("the built-in scout keeps its read-only tools and gains the result channel", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		await mkdir(cwd, { recursive: true });
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");

		const config = await resolveSubagentLaunch({
			input: { task: "Map the callers", agent: "scout", taskContract: TASK_CONTRACT },
			cwd,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: bridge,
		});

		expect(config.agent.sourcePath).toBe("<builtin>/scout.md");
		expect(config.tools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"contact_parent",
			"submit_task_result",
		]);
	});
});

test("a Task child's tool allowlist includes the result channel it must use", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "agents", "limited.md"),
			"---\nname: limited\ntools:\n  - read\n  - contact_parent\n---\nDo the work.\n",
			"utf8",
		);
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");

		const conversational = await resolveSubagentLaunch({
			input: { task: "Review the file", agent: "limited" },
			cwd,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: bridge,
		});
		expect(conversational.tools).toEqual(["read", "contact_parent"]);
		expect(conversational.task).toBeUndefined();

		// Without this the child could never submit a result and every task would settle as
		// invalid_result while the child had no way to say what went wrong.
		const asTask = await resolveSubagentLaunch({
			input: { task: "Review the file", agent: "limited", taskContract: TASK_CONTRACT },
			cwd,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: bridge,
		});
		expect(asTask.tools).toEqual(["read", "contact_parent", "submit_task_result"]);
		expect(asTask.task).toEqual(TASK_CONTRACT);
	});
});

test("refuses to run a Task whose result channel is excluded", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "agents", "excluded.md"),
			"---\nname: excluded\nexclude_tools:\n  - submit_task_result\n---\nDo the work.\n",
			"utf8",
		);
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");

		await expect(
			resolveSubagentLaunch({
				input: { task: "Review the file", agent: "excluded", taskContract: TASK_CONTRACT },
				cwd,
				parent: PARENT,
				modelRegistry: MODEL_REGISTRY,
				bridgeExtensionPath: bridge,
			}),
		).rejects.toThrow(/exclude_tools cannot disable submit_task_result/u);
	});
});

test("requires an explicit agent name instead of inventing a default", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		await expect(
			resolveSubagentLaunch({
				input: { task: "Do something", agent: "   " },
				cwd: directory,
				parent: PARENT,
				modelRegistry: MODEL_REGISTRY,
				bridgeExtensionPath: join(directory, "bridge.js"),
			}),
		).rejects.toThrow(/explicit agent name/u);
	});
});

test("persists the spawn intent before any process starts and keeps the task recoverable", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		await writeAgent(cwd);
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		const registry = createSubagentRegistry({
			parentSessionId: PARENT_SESSION_ID,
			filePath: join(directory, "registry.json"),
		});
		const config = await resolveSubagentLaunch({
			input: { task: "Fix the failing test", agent: "worker" },
			cwd,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			invocation: { command: "/usr/bin/node", args: ["/usr/lib/pi/cli.js"] },
			bridgeExtensionPath: bridge,
		});

		const record = await persistSubagentIntent({
			registry,
			parentSessionId: PARENT_SESSION_ID,
			task: "Fix the failing test",
			launchConfig: config,
		});

		expect(record).toMatchObject({
			subagentId: config.subagentId,
			sessionId: config.sessionId,
			initialTask: "Fix the failing test",
			unacknowledgedInput: "Fix the failing test",
			state: "starting",
			mode: "rpc",
			persistence: "never_flushed",
			intent: "active",
			revision: 1,
		});
		expect(record.sessionPath).toBeUndefined();
		expect(await registry.get(config.subagentId)).toEqual(record);
	});
});

test("a Task child's result contract survives persistence", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		await writeAgent(cwd);
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		const contract = {
			schema: {
				type: "object",
				properties: { answer: { type: "string" } },
				required: ["answer"],
			},
			softTurns: 60,
		};
		const registry = createSubagentRegistry({
			parentSessionId: PARENT_SESSION_ID,
			filePath: join(directory, "registry.json"),
		});
		const config = await resolveSubagentLaunch({
			input: { task: "Answer the question", agent: "worker", taskContract: contract },
			cwd,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: bridge,
		});

		await persistSubagentIntent({
			registry,
			parentSessionId: PARENT_SESSION_ID,
			task: "Answer the question",
			launchConfig: config,
		});

		// Every later launch step re-reads the record from disk, so a contract field the record
		// parser does not accept makes the child impossible to start.
		expect((await registry.get(config.subagentId))?.launchConfig.task).toEqual(contract);
	});
});

test("refuses to persist an intent whose registry belongs to another parent session", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		await writeAgent(cwd);
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		const registry = createSubagentRegistry({
			parentSessionId: "01J7-other",
			filePath: join(directory, "registry.json"),
		});
		const config = await resolveSubagentLaunch({
			input: { task: "Work", agent: "worker" },
			cwd,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: bridge,
		});
		await expect(
			persistSubagentIntent({
				registry,
				parentSessionId: PARENT_SESSION_ID,
				task: "Work",
				launchConfig: config,
			}),
		).rejects.toThrow(/belongs to parent session/u);
		expect(await registry.list()).toEqual([]);
	});
});

test("never mints a new identity for a never-flushed session and adopts a flushed file", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		const sessionDir = join(directory, "sessions");
		const fresh = await planSessionPlacement({ sessionId: "01J7-child", cwd, sessionDir });
		expect(fresh).toEqual({
			sessionId: "01J7-child",
			sessionDir,
			persistence: "never_flushed",
		});

		const adopted = await writeSessionFile(sessionDir, "01J7-child", cwd);
		const planned = await planSessionPlacement({ sessionId: "01J7-child", cwd, sessionDir });
		expect(planned).toEqual({
			sessionId: "01J7-child",
			sessionDir,
			sessionPath: adopted,
			persistence: "flushed",
		});
		expect(await findSessionFile(sessionDir, "01J7-child")).toBe(adopted);
		expect(await findSessionFile(sessionDir, "01J7-absent")).toBeUndefined();
	});
});

test("fails closed when a flushed session is missing, corrupt, or carries another id", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		const sessionDir = join(directory, "sessions");
		const path = await writeSessionFile(sessionDir, "01J7-child", cwd);

		await expect(
			planSessionPlacement({
				sessionId: "01J7-child",
				cwd,
				sessionDir,
				sessionPath: join(sessionDir, "2026-01-01T00-00-00-000Z_01J7-gone.jsonl"),
				persistence: "flushed",
			}),
		).rejects.toThrow(/Recorded session file is missing/u);

		await writeFile(path, "{not json\n", "utf8");
		await expect(inspectSessionFile(path, "01J7-child")).rejects.toThrow(/unreadable header/u);

		await writeFile(path, `${JSON.stringify({ type: "session", id: "01J7-other" })}\n`, "utf8");
		await expect(inspectSessionFile(path, "01J7-child")).rejects.toThrow(
			/belongs to session 01J7-other/u,
		);

		await expect(
			planSessionPlacement({
				sessionId: "01J7-child",
				cwd,
				sessionDir,
				sessionPath: path,
				persistence: "flushed",
			}),
		).rejects.toThrow(/belongs to session 01J7-other/u);
	});
});

test("promotes a never-flushed child to flushed once its file exists", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		await writeAgent(cwd);
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		const registry = createSubagentRegistry({
			parentSessionId: PARENT_SESSION_ID,
			filePath: join(directory, "registry.json"),
		});
		const config = await resolveSubagentLaunch({
			input: { task: "Work", agent: "worker" },
			cwd,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: bridge,
		});
		const record = await persistSubagentIntent({
			registry,
			parentSessionId: PARENT_SESSION_ID,
			task: "Work",
			launchConfig: config,
		});

		const path = await writeSessionFile(config.sessionDir, config.sessionId, cwd);
		const promoted = await planSessionPlacement({
			sessionId: record.sessionId,
			cwd,
			sessionDir: config.sessionDir,
		});
		expect(promoted.persistence).toBe("flushed");
		expect(promoted.sessionPath).toBe(path);
		expect(config.sessionDir).toBe(promoted.sessionDir);
	});
});

test("does not start a child when the registry write fails", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		await writeAgent(cwd);
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		const registryPath = join(directory, "registry.json");
		const registry = createSubagentRegistry({
			parentSessionId: PARENT_SESSION_ID,
			filePath: registryPath,
		});
		await writeFile(registryPath, "{not json", "utf8");
		const config = await resolveSubagentLaunch({
			input: { task: "Work", agent: "worker" },
			cwd,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: bridge,
		});
		await expect(
			persistSubagentIntent({
				registry,
				parentSessionId: PARENT_SESSION_ID,
				task: "Work",
				launchConfig: config,
			}),
		).rejects.toThrow(/Invalid JSON/u);
		expect(await readFile(registryPath, "utf8")).toBe("{not json");
	});
});

test("freezes interactive from the agent definition into launch config", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "agents", "worker.md"),
			"---\nname: worker\ninteractive: true\n---\nStay in the TUI.\n",
			"utf8",
		);
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");

		const config = await resolveSubagentLaunch({
			input: { task: "Review in TUI", agent: "worker" },
			cwd,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			invocation: { command: "/usr/bin/node", args: ["/usr/lib/pi/cli.js"] },
			bridgeExtensionPath: bridge,
		});

		expect(config.interactive).toBe(true);
	});
});
