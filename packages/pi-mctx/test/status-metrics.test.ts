import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	computeMctxTokenBreakdown,
	computeMctxToolDefinitionTokens,
	computeMctxWorkMetrics,
} from "../src/status-metrics.js";

test("work metrics accumulate prompt deltas and reset phases", (): void => {
	const entries = [
		{ type: "message", message: { role: "assistant", usage: { input: 100, output: 3 } } },
		{ type: "message", message: { role: "assistant", usage: { input: 150, output: 5 } } },
		{ type: "message", message: { role: "assistant", usage: { input: 80, output: 7 } } },
	] as unknown as SessionEntry[];
	expect(computeMctxWorkMetrics(entries)).toEqual({
		newWorkTokens: 157,
		totalInputTokens: 230,
	});
});

test("token breakdown separates MCTX, conversation, tool calls, and system", (): void => {
	const messages = [
		{ role: "custom", customType: "pi-mctx:m0", content: "summary", display: false, timestamp: 0 },
		{ role: "user", content: "request", timestamp: 0 },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "answer" },
				{ type: "toolCall", name: "read", arguments: { path: "a" }, id: "1" },
			],
			timestamp: 0,
		},
		{
			role: "toolResult",
			toolCallId: "1",
			toolName: "read",
			content: [{ type: "text", text: "file" }],
			isError: false,
			timestamp: 0,
		},
	] as unknown as AgentMessage[];
	const breakdown = computeMctxTokenBreakdown(messages, { systemPrompt: "system" });
	expect(breakdown.systemPrompt).toBeGreaterThan(0);
	expect(breakdown.compartments).toBeGreaterThan(0);
	expect(breakdown.conversation).toBeGreaterThan(0);
	expect(breakdown.toolCalls).toBeGreaterThan(0);
	expect(breakdown.docs).toBe(0);
});

test("tool definition tokens include metadata and schema", (): void => {
	const tokens = computeMctxToolDefinitionTokens([
		{ name: "read", description: "Read a file", parameters: { type: "object" } },
	]);
	expect(tokens).toBeGreaterThan(0);
});
