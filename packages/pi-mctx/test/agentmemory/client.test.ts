import { describe, expect, it } from "vitest";
import { AgentMemoryClient, decodeAgentMemorySearchResults } from "../../src/agentmemory/client";

describe("Hindsight-backed AgentMemory compatibility client", () => {
	it("rejects invalid URLs before constructing a backend client", () => {
		expect(() => new AgentMemoryClient({ url: "mailto:memory@example.test" })).toThrow(
			expect.objectContaining({ kind: "invalid_url", endpoint: "client" }),
		);
	});

	it("fails closed when requireHttps meets a bearer secret over remote HTTP", async () => {
		const client = new AgentMemoryClient({
			url: "http://example.test",
			secret: "tok",
			requireHttps: true,
		});
		await expect(client.health()).rejects.toMatchObject({ kind: "insecure_transport" });
	});

	it("decodes Hindsight recall result envelopes", () => {
		expect(
			decodeAgentMemorySearchResults({
				results: [{ id: "m1", text: "fact", score: 0.9 }],
				observations: [{ observation: { id: "o1", text: "saw it" } }],
			}),
		).toEqual([
			{
				id: "m1",
				content: "fact",
				kind: "memory",
				score: 0.9,
				digest: expect.any(String),
			},
			{ id: "o1", content: "saw it", kind: "observation", digest: expect.any(String) },
		]);
	});
});
