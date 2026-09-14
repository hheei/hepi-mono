import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_AGENTMEMORY_URL,
	MagicContextConfigSchema,
} from "#core/config/schema/magic-context";
import { AgentMemoryClient, decodeAgentMemorySearchResults } from "../../src/agentmemory/client";
import {
	capturePrompt,
	createAgentMemoryRuntime,
	overlayAgentMemoryEnv,
	resolveAgentMemoryProject,
} from "../../src/agentmemory/runtime";

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
			{ id: "m1", content: "fact", kind: "memory", score: 0.9 },
			{ id: "o1", content: "saw it", kind: "observation" },
		]);
	});
});

describe("AgentMemory runtime", () => {
	it("overlays env without treating Docker as a runtime assumption", () => {
		expect(defaults.url).toBe(DEFAULT_AGENTMEMORY_URL);
		expect(overlayAgentMemoryEnv(defaults, { AGENTMEMORY_URL: "https://am.example/v1/" }).url).toBe(
			"https://am.example/v1/",
		);
		expect(resolveAgentMemoryProject("/tmp/hepi-mono", "")).toBe("hepi-mono");
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
});
