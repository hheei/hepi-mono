import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentMemoryClient, decodeAgentMemorySearchResults } from "../../src/agentmemory/client";

type RequestRecord = {
	pathname: string;
	body: unknown;
};

type Fixture = {
	url: string;
	requests: RequestRecord[];
	close(): Promise<void>;
	requested: Promise<void>;
};

type Responder = (request: RequestRecord) => unknown | undefined;

const fixtures: Fixture[] = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function localFixture(responder: Responder): Promise<Fixture> {
	const requests: RequestRecord[] = [];
	let resolveRequested: (() => void) | undefined;
	const requested = new Promise<void>((resolve) => {
		resolveRequested = resolve;
	});
	const server = createServer((request, response) => {
		let rawBody = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			rawBody += chunk;
		});
		request.on("end", () => {
			const record = {
				pathname: new URL(request.url ?? "/", "http://fixture.test").pathname,
				body: rawBody.length === 0 ? undefined : JSON.parse(rawBody),
			};
			requests.push(record);
			resolveRequested?.();
			const responseBody = responder(record);
			if (responseBody !== undefined) {
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify(responseBody));
			}
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture did not bind a TCP port");
	const fixture: Fixture = {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		requested,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
				server.closeAllConnections();
			});
		},
	};
	fixtures.push(fixture);
	return fixture;
}

describe("AgentMemoryClient", () => {
	it("narrows successful responses from every bridge endpoint", async () => {
		const fixture = await localFixture(({ pathname }) => {
			switch (pathname) {
				case "/agentmemory/health":
					return { status: "ready" };
				case "/agentmemory/session/start":
					return { session: { id: "remote-session" } };
				case "/agentmemory/observe":
					return { success: true, observationId: "observation-1" };
				case "/agentmemory/search":
					return { results: [] };
				case "/agentmemory/remember":
					return { success: true, memory: { id: "memory-1" } };
				case "/agentmemory/session/end":
					return { ended: true };
				default:
					throw new Error(`unexpected endpoint: ${pathname}`);
			}
		});
		const client = new AgentMemoryClient({ url: fixture.url });

		await expect(client.health()).resolves.toMatchObject({ status: "ready" });
		await expect(
			client.startSession({ sessionId: "local", project: "project", cwd: "/work" }),
		).resolves.toEqual({
			sessionId: "remote-session",
		});
		await expect(
			client.observe({
				sessionId: "remote-session",
				hookType: "tool_result",
				data: { tool: "git" },
			}),
		).resolves.toEqual({ observationId: "observation-1" });
		await expect(client.search({ query: "git", project: "project" })).resolves.toEqual({
			results: [],
		});
		await expect(client.remember({ content: "Use pnpm", project: "project" })).resolves.toEqual({
			success: true,
			memory: { id: "memory-1" },
		});
		await expect(client.endSession("remote-session")).resolves.toBeUndefined();

		expect(fixture.requests).toEqual([
			{ pathname: "/agentmemory/health", body: undefined },
			{
				pathname: "/agentmemory/session/start",
				body: { sessionId: "local", project: "project", cwd: "/work" },
			},
			{
				pathname: "/agentmemory/observe",
				body: expect.objectContaining({
					sessionId: "remote-session",
					hookType: "tool_result",
					data: { tool: "git" },
				}),
			},
			{
				pathname: "/agentmemory/search",
				body: { format: "full", query: "git", project: "project" },
			},
			{ pathname: "/agentmemory/remember", body: { content: "Use pnpm", project: "project" } },
			{ pathname: "/agentmemory/session/end", body: { sessionId: "remote-session" } },
		]);
	});

	it("rejects malformed successful HTTP bodies for every endpoint", async () => {
		const invalidBodies: Record<string, unknown> = {
			"/agentmemory/health": { status: "offline" },
			"/agentmemory/session/start": { success: false },
			"/agentmemory/observe": [],
			"/agentmemory/search": { ok: false },
			"/agentmemory/remember": { success: true, memory: {} },
			"/agentmemory/session/end": { ended: false },
		};
		const fixture = await localFixture(({ pathname }) => invalidBodies[pathname]);
		const client = new AgentMemoryClient({ url: fixture.url });
		const calls: Array<[string, () => Promise<unknown>]> = [
			["health", () => client.health()],
			[
				"session/start",
				() => client.startSession({ sessionId: "local", project: "project", cwd: "/work" }),
			],
			["observe", () => client.observe({ sessionId: "local", hookType: "tool_result", data: {} })],
			["search", () => client.search({ query: "git", project: "project" })],
			["remember", () => client.remember({ content: "Use pnpm", project: "project" })],
			["session/end", () => client.endSession("local")],
		];
		for (const [endpoint, call] of calls) {
			await expect(call()).rejects.toMatchObject({ kind: "invalid_response", endpoint });
		}
	});

	it("classifies invalid URLs, HTTP failures, and network failures", async () => {
		expect(() => new AgentMemoryClient({ url: "mailto:memory@example.test" })).toThrow(
			expect.objectContaining({ kind: "invalid_url", endpoint: "client" }),
		);

		const httpClient = new AgentMemoryClient(
			{ url: "http://fixture.test" },
			async () => new Response("unavailable", { status: 503 }),
		);
		await expect(httpClient.health()).rejects.toMatchObject({
			kind: "http",
			endpoint: "health",
			status: 503,
		});

		const offlineClient = new AgentMemoryClient({ url: "http://fixture.test" }, async () => {
			throw new TypeError("offline");
		});
		await expect(offlineClient.health()).rejects.toMatchObject({
			kind: "network",
			endpoint: "health",
		});
	});

	it("classifies fixture-backed timeouts and caller cancellation", async () => {
		const timeoutFixture = await localFixture(() => undefined);
		const timeoutClient = new AgentMemoryClient({ url: timeoutFixture.url });
		await expect(timeoutClient.health({ timeoutMs: 50 })).rejects.toMatchObject({
			kind: "timeout",
		});

		const cancelFixture = await localFixture(() => undefined);
		const cancelClient = new AgentMemoryClient({ url: cancelFixture.url });
		const controller = new AbortController();
		const pending = cancelClient.health({ signal: controller.signal, timeoutMs: 1_000 });
		await cancelFixture.requested;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ kind: "cancelled", endpoint: "health" });
	});

	it("fails closed when requireHttps meets a bearer secret over remote HTTP", async () => {
		const client = new AgentMemoryClient(
			{ url: "http://example.test", secret: "tok", requireHttps: true },
			vi.fn<typeof fetch>(),
		);
		await expect(client.health()).rejects.toMatchObject({ kind: "insecure_transport" });
	});

	it("decodes nested search envelopes with snake-case scope metadata", () => {
		expect(
			decodeAgentMemorySearchResults({
				results: [
					{ memory: { id: "m1", content: "fact" }, score: 0.9 },
					{
						project_name: "hepi-mono",
						session_id: "session-1",
						agent_id: "agent-1",
						memory: { id: "m2", content: "scoped fact" },
					},
				],
				observations: [{ observation: { id: "o1", text: "saw it" } }],
			}),
		).toEqual([
			{ id: "m1", content: "fact", kind: "memory", score: 0.9, digest: expect.any(String) },
			{
				id: "m2",
				content: "scoped fact",
				kind: "memory",
				project: "hepi-mono",
				sessionId: "session-1",
				agentId: "agent-1",
				digest: expect.any(String),
			},
			{ id: "o1", content: "saw it", kind: "observation", digest: expect.any(String) },
		]);
	});
});
