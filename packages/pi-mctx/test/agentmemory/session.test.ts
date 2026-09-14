import { describe, expect, it, vi } from "vitest";
import type { AgentMemoryClientPort } from "../../src/agentmemory/client";
import { AgentMemorySessionManager } from "../../src/agentmemory/session";

function client(overrides: Partial<AgentMemoryClientPort> = {}): AgentMemoryClientPort {
	return {
		async health() {
			return { status: "ok" };
		},
		async startSession(input) {
			return { sessionId: input.sessionId };
		},
		async observe() {
			return { observationId: "obs" };
		},
		async search() {
			return { results: [] };
		},
		async remember() {
			return { success: true, memory: { id: "mem" } };
		},
		async endSession() {},
		...overrides,
	};
}

const context = (sessionId: string) => ({
	cwd: "/tmp/repository",
	sessionManager: { getSessionId: () => sessionId },
});

describe("AgentMemorySessionManager", () => {
	it("coalesces repeated starts and keeps switched sessions isolated", async () => {
		const startSession = vi.fn(async (input: { sessionId: string }) => ({
			sessionId: input.sessionId,
		}));
		const manager = new AgentMemorySessionManager({
			client: client({ startSession }),
			resolveIdentity: () => ({ project: "repository" }),
			enabled: () => true,
			activationId: "activation",
		});

		const [first, duplicate] = await Promise.all([
			manager.startForContext(context("session-a")),
			manager.startForContext(context("session-a")),
		]);
		const second = await manager.startForContext(context("session-b"));

		expect(first?.remoteSessionId).toBe(duplicate?.remoteSessionId);
		expect(second?.remoteSessionId).not.toBe(first?.remoteSessionId);
		expect(startSession).toHaveBeenCalledTimes(2);
		await manager.shutdown();
	});

	it("aborts an in-flight start and leaves no binding during shutdown", async () => {
		const health = vi.fn(
			(options?: { signal?: AbortSignal }) =>
				new Promise<{ status: string }>((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
						once: true,
					});
				}),
		);
		const startSession = vi.fn();
		const manager = new AgentMemorySessionManager({
			client: client({ health, startSession }),
			resolveIdentity: () => ({ project: "repository" }),
			enabled: () => true,
		});

		const pending = manager.startForContext(context("session-a"));
		await vi.waitFor(() => expect(health).toHaveBeenCalledTimes(1));
		await manager.shutdown();

		await expect(pending).resolves.toBeUndefined();
		expect(startSession).not.toHaveBeenCalled();
		expect(manager.bindings).toEqual([]);
	});

	it("ends every live binding exactly once on repeated shutdown", async () => {
		const endSession = vi.fn(async () => {});
		const manager = new AgentMemorySessionManager({
			client: client({ endSession }),
			resolveIdentity: () => ({ project: "repository" }),
			enabled: () => true,
		});
		await manager.startForContext(context("session-a"));
		await manager.startForContext(context("session-b"));

		await manager.shutdown();
		await manager.shutdown();

		expect(endSession).toHaveBeenCalledTimes(2);
	});
});
