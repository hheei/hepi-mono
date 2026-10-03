import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ThinkingLevel } from "../src/domain.js";
import { createSubagentRegistry } from "../src/registry.js";
import {
	createSubagentId,
	findSessionFile,
	inspectSessionFile,
	persistSubagentIntent,
	planSessionPlacement,
	resetSubagentIdCounter,
	resolveDefaultSessionDir,
	resolveSubagentLaunch,
	resolveSubagentSessionDir,
} from "../src/session-bootstrap.js";
import { withTempDir } from "./helpers/tmp-dir.js";

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

		expect(config.subagentId).toMatch(/^agent-\d+$/u);
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

test("createSubagentId produces sequential agent-X ids and respects existing ones", () => {
	resetSubagentIdCounter(0);
	expect(createSubagentId()).toBe("agent-1");
	expect(createSubagentId()).toBe("agent-2");

	// When existing ids are provided, it jumps to the next available number
	expect(createSubagentId(["agent-1", "agent-2", "agent-5"])).toBe("agent-6");
	expect(createSubagentId()).toBe("agent-7");
});

test("the built-in scout keeps its read-only tools and gains the result channel", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		await mkdir(cwd, { recursive: true });
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");

		const config = await resolveSubagentLaunch({
			input: { task: "Map the callers", agent: "scout" },
			cwd,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: bridge,
		});

		expect(config.agent.sourcePath).toBe("<builtin>/scout.md");
		expect(config.tools).toEqual(["read", "grep", "find", "ls", "contact_parent"]);
	});
});

test("a launch resolves its skill names against the parent's loaded skills", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "agents", "reviewer.md"),
			"---\nname: reviewer\nskills:\n  - code-review\n  - ponytail-review\n---\nReview it.\n",
			"utf8",
		);
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		const warnings: string[] = [];

		const config = await resolveSubagentLaunch({
			input: { task: "Review the diff", agent: "reviewer" },
			cwd,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: bridge,
			skillCatalog: [
				{ name: "code-review", path: "/skills/code-review/SKILL.md" },
				{ name: "ponytail-review", path: "/skills/ponytail-review/SKILL.md" },
			],
			onWarning: (message) => warnings.push(message),
		});

		// The child gets exactly these two skills; nothing else is inherited.
		expect(config.skills).toEqual({
			discovery: false,
			paths: ["/skills/code-review/SKILL.md", "/skills/ponytail-review/SKILL.md"],
		});
		expect(warnings).toEqual([]);

		await writeFile(
			join(cwd, ".pi", "agents", "reviewer.md"),
			"---\nname: reviewer\nskills:\n  - ghost\n---\nReview it.\n",
			"utf8",
		);
		const unknown = await resolveSubagentLaunch({
			input: { task: "Review the diff", agent: "reviewer" },
			cwd,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: bridge,
			skillCatalog: [{ name: "code-review", path: "/skills/code-review/SKILL.md" }],
			onWarning: (message) => warnings.push(message),
		});
		// A name nobody loaded warns and narrows to nothing rather than falling back to everything.
		expect(unknown.skills).toEqual({ discovery: false, paths: [] });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("ghost");
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
			presentation: "background",
			persistence: "never_flushed",
			intent: "active",
			revision: 1,
		});
		expect(record.sessionPath).toBeUndefined();
		expect(await registry.get(config.subagentId)).toEqual(record);
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

test("keeps delegated sessions in a child-scoped subdirectory of the parent session dir", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		const expected = join(resolveDefaultSessionDir(cwd), "agents");
		expect(resolveSubagentSessionDir(cwd)).toBe(expected);
		const planned = await planSessionPlacement({ sessionId: "01J7-child", cwd });
		expect(planned).toEqual({
			sessionId: "01J7-child",
			sessionDir: expected,
			persistence: "never_flushed",
		});
	});
});

test("freezes the requested spawn title and treats a blank one as absent", async (): Promise<void> => {
	await withTempDir("pi-subagents-bootstrap-", async (directory) => {
		const cwd = join(directory, "work");
		await writeAgent(cwd);
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		const shared = {
			cwd,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: bridge,
		};
		const derived = await resolveSubagentLaunch({
			...shared,
			input: { task: "Fix the failing test", agent: "worker" },
		});
		expect(derived.title).toBeUndefined();

		const titled = await resolveSubagentLaunch({
			...shared,
			input: {
				task: "Fix the failing test",
				agent: "worker",
				title: "  OVITO properties editor  ",
			},
		});
		expect(titled.title).toBe("OVITO properties editor");

		// A blank title means "name it yourself", not a failure: it never reaches the config.
		const blank = await resolveSubagentLaunch({
			...shared,
			input: { task: "Fix the failing test", agent: "worker", title: "   " },
		});
		expect(blank.title).toBeUndefined();
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
