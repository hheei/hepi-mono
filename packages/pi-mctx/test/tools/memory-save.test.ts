import { describe, expect, it, vi } from "vitest";
import { createMemorySaveTool } from "../../src/tools/memory-save";
import { asToolResult, fakeContext } from "../test-utils.test";

describe("mctx_memory AgentMemory implementation", () => {
	it("reports queued without claiming remote delivery", async () => {
		const queueMemory = vi.fn(async () => ({ status: "queued" as const, id: "outbox-1" }));
		const tool = createMemorySaveTool({ queueMemory });
		const result = asToolResult(
			await tool.execute(
				"call-save",
				{ content: " Use pnpm. ", type: "workflow" },
				new AbortController().signal,
				undefined,
				fakeContext() as never,
			),
		);
		expect(tool.name).toBe("mctx_memory");
		expect(result.content[0]?.text).toBe("queued: outbox-1");
		expect(queueMemory).toHaveBeenCalledWith({
			cwd: process.cwd(),
			content: "Use pnpm.",
			type: "workflow",
		});
	});

	it("returns a truthful failed dedupe state", async () => {
		const tool = createMemorySaveTool({
			queueMemory: vi.fn(async () => ({ status: "failed" as const, id: "outbox-failed" })),
		});
		const result = asToolResult(
			await tool.execute(
				"call-save",
				{ content: "Cannot deliver" },
				new AbortController().signal,
				undefined,
				fakeContext() as never,
			),
		);
		expect(result.content[0]?.text).toBe("failed: outbox-failed");
	});
});
