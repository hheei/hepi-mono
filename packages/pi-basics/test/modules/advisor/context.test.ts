import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildTurnDelta,
	extractPrimaryTurnEvidence,
} from "../../../src/modules/advisor/context.js";
import { buildAdvisorBootstrapMessages } from "../../../src/modules/advisor/runtime.js";

const text = (role: "user" | "assistant", value: string): Message =>
	({ role, content: [{ type: "text", text: value }] }) as Message;
const call = (id: string): Message =>
	({
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: {} }],
	}) as Message;
const result = (id: string): Message =>
	({
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		isError: false,
	}) as Message;

function hasContent(
	message: AgentMessage,
): message is AgentMessage & { readonly content: unknown } {
	return typeof message === "object" && message !== null && "content" in message;
}

function bootstrap(source: readonly Message[]): AgentMessage[] {
	const ctx = {
		sessionManager: { buildSessionContext: () => ({ messages: source }) },
	} as unknown as ExtensionContext;
	return buildAdvisorBootstrapMessages({ ctx, model: undefined, thinking: "off" });
}

describe("advisor turn evidence", () => {
	test("extracts assistant text and tool calls", () => {
		const evidence = extractPrimaryTurnEvidence({
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "assistant answer" },
					{ type: "toolCall", name: "read", id: "call-7", arguments: { path: "x.ts" } },
				],
			},
		});
		expect(evidence.assistant).toContain("assistant answer");
		expect(evidence.assistant).toContain("read");
		expect(evidence.assistant).toContain("call-7");
		expect(evidence.assistant).toContain("x.ts");
	});

	test("excludes thinking blocks", () => {
		const evidence = extractPrimaryTurnEvidence({
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "THINKING_SECRET_MARKER" },
					{ type: "text", text: "visible" },
				],
			},
		});
		expect(evidence.assistant).toContain("visible");
		expect(evidence.assistant).not.toContain("THINKING_SECRET_MARKER");
	});

	test("extracts tool result status and details", () => {
		const evidence = extractPrimaryTurnEvidence({
			message: { role: "assistant", content: [] },
			toolResults: [
				{
					toolName: "edit",
					toolCallId: "call-8",
					isError: true,
					content: [{ type: "text", text: "failed" }],
					details: "EDIT_DIFF_MARKER",
				},
			],
		});
		expect(evidence.tools[0]).toContain("edit");
		expect(evidence.tools[0]).toContain("call-8");
		expect(evidence.tools[0]).toContain("ERROR");
		expect(evidence.tools[0]).toContain("failed");
		expect(evidence.tools[0]).toContain("EDIT_DIFF_MARKER");
	});

	test("truncates turn evidence within an explicit budget", () => {
		const delta = buildTurnDelta(
			"user",
			"assistant evidence ".repeat(100),
			["tool evidence ".repeat(100)],
			{
				contextWindow: 1100,
				responseReserve: 100,
			},
		);
		expect(delta.assistant).toContain("advisor context truncated");
		expect(delta.tools?.[0]).toContain("advisor context truncated");
		expect(
			delta.user.length + (delta.assistant?.length ?? 0) + (delta.tools?.[0]?.length ?? 0),
		).toBeLessThan(2300);
	});
});

describe("advisor bootstrap context", () => {
	test("filters advisory custom messages before conversion", () => {
		const advisory = {
			role: "custom",
			customType: "pi-basics-advisory",
			content: [],
		} as unknown as Message;
		const source = [text("user", "keep"), advisory, text("assistant", "also keep")];
		expect(bootstrap(source)).toEqual(source.filter((item) => item !== advisory));
	});

	test("preserves complete tool pairs and useful assistant text", () => {
		const source = [text("user", "prompt"), call("c1"), result("c1"), text("assistant", "done")];
		expect(bootstrap(source)).toEqual(source);
	});

	test("trims an incomplete trailing call but keeps assistant text", () => {
		const assistant = {
			role: "assistant",
			content: [
				{ type: "text", text: "useful" },
				{ type: "toolCall", id: "c1", name: "read", arguments: {} },
			],
		} as Message;
		const output = bootstrap([text("user", "prompt"), assistant]);
		expect(output).toHaveLength(2);
		const sanitized = output[1];
		expect(
			sanitized !== undefined && hasContent(sanitized) ? sanitized.content : undefined,
		).toEqual([{ type: "text", text: "useful" }]);
	});

	test("trims an incomplete call before a user tail and preserves the tail", () => {
		const assistant = {
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
		} as Message;
		const userTail = text("user", "tail");
		const prompt = text("user", "prompt");
		const output = bootstrap([prompt, assistant, userTail]);
		expect(output).toHaveLength(2);
		expect(output[0]).toBe(prompt);
		expect(output[1]).toBe(userTail);
	});

	test("removes an orphan trailing result", () => {
		const source = [text("user", "prompt"), result("missing")];
		expect(bootstrap(source)).toEqual(source.slice(0, 1));
	});

	test("preserves resolved summaries and prefix identity/order", () => {
		const summary = text("user", "compaction summary");
		const prefix = text("assistant", "earlier");
		const output = bootstrap([summary, prefix, call("c1")]);
		expect(output.slice(0, 2)).toEqual([summary, prefix]);
		expect(output[0]).toBe(summary);
		expect(output[1]).toBe(prefix);
	});
});
