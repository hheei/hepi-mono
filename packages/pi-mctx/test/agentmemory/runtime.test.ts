import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_AGENTMEMORY_URL,
	MagicContextConfigSchema,
} from "#core/config/schema/magic-context";
import { AgentMemoryClient, decodeAgentMemorySearchResults } from "../../src/agentmemory/client";
import {
	clearAgentMemoryProjectCache,
	createAgentMemoryIdentityResolver,
	resolveAgentMemoryProject,
} from "../../src/agentmemory/project";
import {
	capturePrompt,
	createAgentMemoryRuntime,
	overlayAgentMemoryEnv,
} from "../../src/agentmemory/runtime";
import { createPlaintextBearerAuthGuard } from "../../src/agentmemory/security";
import { closeQuietly } from "../../src/core/shared/sqlite-helpers";
import { createTestDb } from "../test-utils.test";

const defaults = MagicContextConfigSchema.parse({}).agentmemory;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("AgentMemory HTTP client", () => {
	it("posts to /agentmemory/remember and returns the memory id", async () => {
		const fetchImpl = vi.fn(async () => {
			return new Response(JSON.stringify({ success: true, memory: { id: "mem_1" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const client = new AgentMemoryClient(
			{ url: "http://127.0.0.1:3111" },
			fetchImpl as typeof fetch,
		);
		const result = await client.remember({ content: "use pnpm", project: "hepi-mono" });
		expect(result.memory.id).toBe("mem_1");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(String(fetchImpl.mock.calls.at(0)?.at(0))).toBe(
			"http://127.0.0.1:3111/agentmemory/remember",
		);
		expect(fetchImpl.mock.calls.at(0)?.at(1)).toMatchObject({ method: "POST" });
	});

	it("fails closed when requireHttps meets a bearer secret over remote HTTP", async () => {
		const client = new AgentMemoryClient(
			{ url: "http://example.test", secret: "tok", requireHttps: true },
			vi.fn() as unknown as typeof fetch,
		);
		await expect(client.health()).rejects.toMatchObject({ kind: "insecure_transport" });
	});

	it("decodes nested search envelopes", () => {
		expect(
			decodeAgentMemorySearchResults({
				results: [{ memory: { id: "m1", content: "fact" }, score: 0.9 }],
				observations: [{ observation: { id: "o1", text: "saw it" } }],
			}),
		).toEqual([
			{ id: "m1", content: "fact", kind: "memory", score: 0.9, digest: expect.any(String) },
			{ id: "o1", content: "saw it", kind: "observation", digest: expect.any(String) },
		]);
	});

	it("decodes snake-case search scope metadata", () => {
		expect(
			decodeAgentMemorySearchResults({
				results: [
					{
						project_name: "hepi-mono",
						session_id: "session-1",
						agent_id: "agent-1",
						memory: { id: "m1", content: "fact" },
					},
				],
			}),
		).toEqual([
			{
				id: "m1",
				content: "fact",
				kind: "memory",
				project: "hepi-mono",
				sessionId: "session-1",
				agentId: "agent-1",
				digest: expect.any(String),
			},
		]);
	});
});

describe("AgentMemory runtime", () => {
	it("resolves project and agent identity with environment, git-root, then cwd precedence", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-mctx-agentmemory-"));
		const repository = join(root, "repo-name");
		const nested = join(repository, "packages", "child");
		const plain = join(root, "plain-name");
		mkdirSync(join(repository, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });
		mkdirSync(plain);
		clearAgentMemoryProjectCache();
		try {
			expect(defaults.url).toBe(DEFAULT_AGENTMEMORY_URL);
			expect(
				overlayAgentMemoryEnv(defaults, {
					AGENTMEMORY_URL: "https://am.example/v1/",
					AGENT_ID: "env-agent",
				}),
			).toMatchObject({ url: "https://am.example/v1/", agentId: "env-agent" });
			expect(resolveAgentMemoryProject(nested, {})).toBe("repo-name");
			expect(resolveAgentMemoryProject(plain, {})).toBe("plain-name");
			expect(
				resolveAgentMemoryProject(nested, { AGENTMEMORY_PROJECT_NAME: "explicit-project" }),
			).toBe("explicit-project");
			expect(createAgentMemoryIdentityResolver({ agentId: "setting-agent" }, {})(nested)).toEqual({
				project: "repo-name",
				agentId: "setting-agent",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
			clearAgentMemoryProjectCache();
		}
	});

	it("warns once or fails closed for remote plaintext bearer authentication", () => {
		const warnings: string[] = [];
		const warnGuard = createPlaintextBearerAuthGuard({ warn: (message) => warnings.push(message) });
		warnGuard("http://agentmemory.example", "secret");
		warnGuard("http://agentmemory.example", "secret");
		expect(warnings).toHaveLength(1);
		expect(() =>
			createPlaintextBearerAuthGuard({ requireHttps: true })(
				"http://agentmemory.example",
				"secret",
			),
		).toThrow(/plaintext HTTP/);
		expect(() =>
			createPlaintextBearerAuthGuard({ requireHttps: true })("http://127.0.0.1:3111", "secret"),
		).not.toThrow();
	});

	it("starts a remote session then observes without awaiting the host hook", async () => {
		const calls: string[] = [];
		const client = {
			async health() {
				calls.push("health");
				return { status: "ok" };
			},
			async startSession(input: { sessionId: string }) {
				calls.push("start");
				return { sessionId: input.sessionId };
			},
			async observe() {
				calls.push("observe");
				return { observationId: "obs_1" };
			},
			async search() {
				return { results: [] };
			},
			async remember() {
				return { success: true as const, memory: { id: "mem" } };
			},
			async endSession() {
				calls.push("end");
			},
		};
		const runtime = createAgentMemoryRuntime({ ...defaults, enabled: true }, client);
		const ctx = { cwd: "/tmp/hepi-mono", sessionManager: { getSessionId: () => "ses-1" } };
		capturePrompt(runtime, ctx, "remember the lockfile");
		await vi.waitFor(() => {
			expect(calls).toEqual(["health", "start", "observe"]);
		});
		await runtime.shutdown();
		expect(calls.at(-1)).toBe("end");
	});

	it("records degraded health without turning status reads into probes", async () => {
		const client = {
			health: vi.fn(async () => Promise.reject(new Error("bridge down"))),
			startSession: vi.fn(),
			observe: vi.fn(),
			search: vi.fn(),
			remember: vi.fn(),
			endSession: vi.fn(),
		};
		const runtime = createAgentMemoryRuntime({ ...defaults, enabled: true }, client);
		runtime.ensureStarted({
			cwd: "/tmp/hepi-mono",
			sessionManager: { getSessionId: () => "ses-health-failure" },
		});
		await vi.waitFor(() => expect(client.health).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(runtime.statusSnapshot().health).toBe("degraded"));
		const callsBeforeRead = client.health.mock.calls.length;
		expect(runtime.statusSnapshot()).toMatchObject({
			health: "degraded",
			capture: "idle",
			lastError: "bridge down",
		});
		expect(client.health).toHaveBeenCalledTimes(callsBeforeRead);
		await runtime.shutdown();
	});
	it("admits scoped automatic recall once per durable user anchor", async () => {
		const db = createTestDb();
		const search = vi.fn(async () => ({
			results: [
				{ memory: { id: "matching", content: "Use pnpm", project: "hepi-mono" } },
				{ memory: { id: "wrong-project", content: "Use npm", project: "other" } },
			],
		}));
		const client = {
			health: vi.fn(async () => ({ status: "ok" })),
			startSession: vi.fn(async (input: { sessionId: string }) => ({ sessionId: input.sessionId })),
			observe: vi.fn(async () => ({})),
			search,
			remember: vi.fn(async () => ({ success: true as const, memory: { id: "memory" } })),
			endSession: vi.fn(async () => undefined),
		};
		try {
			const runtime = createAgentMemoryRuntime({ ...defaults, enabled: true }, client, { db });
			const input = {
				cwd: "/tmp/hepi-mono",
				sessionId: "session-recall",
				userEntryId: "user-1",
				query: "package manager",
				branchId: "root",
				generation: 0,
			};
			const first = await runtime.admitAutomaticRecall(input);
			const retried = await runtime.admitAutomaticRecall(input);

			expect(search).toHaveBeenCalledTimes(1);
			expect(first).toMatchObject({
				kind: "admitted",
				reused: false,
				event: { userEntryId: "user-1", sources: [{ id: "matching" }] },
			});
			expect(retried).toMatchObject({ kind: "admitted", reused: true });
			await runtime.shutdown();
		} finally {
			closeQuietly(db);
		}
	});

	it("records recall backend failure without rejecting the context path", async () => {
		const db = createTestDb();
		const client = {
			health: vi.fn(async () => ({ status: "ok" })),
			startSession: vi.fn(async (input: { sessionId: string }) => ({ sessionId: input.sessionId })),
			observe: vi.fn(async () => ({})),
			search: vi.fn(async () => Promise.reject(new Error("recall backend down"))),
			remember: vi.fn(async () => ({ success: true as const, memory: { id: "memory" } })),
			endSession: vi.fn(async () => undefined),
		};
		try {
			const runtime = createAgentMemoryRuntime({ ...defaults, enabled: true }, client, { db });
			await expect(
				runtime.admitAutomaticRecall({
					cwd: "/tmp/hepi-mono",
					sessionId: "session-failure",
					userEntryId: "user-1",
					query: "query",
				}),
			).resolves.toEqual({ kind: "skipped", reason: "unavailable" });
			expect(runtime.statusSnapshot()).toMatchObject({
				inject: "degraded",
				lastError: "recall backend down",
			});
			expect(db.prepare("SELECT count(*) AS count FROM mctx_recall_events").get()).toEqual({
				count: 0,
			});
			await runtime.shutdown();
		} finally {
			closeQuietly(db);
		}
	});
});
