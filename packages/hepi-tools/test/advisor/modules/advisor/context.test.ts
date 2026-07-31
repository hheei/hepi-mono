import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildTurnDelta, extractPrimaryTurnEvidence } from "../../../../src/pi-advisor/context.js";
import { buildAdvisorBootstrapMessages } from "../../../../src/pi-advisor/runtime.js";

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

function bootstrap(
	source: readonly Message[],
	budget?: { contextWindow: number; responseReserve: number },
): AgentMessage[] {
	const ctx = {
		sessionManager: { buildSessionContext: () => ({ messages: source }) },
	} as unknown as ExtensionContext;
	return buildAdvisorBootstrapMessages({ ctx, model: undefined, thinking: "off" }, budget);
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

	test("extracts successful diff but omits arbitrary result details", () => {
		const evidence = extractPrimaryTurnEvidence({
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						name: "edit",
						id: "call-8",
						arguments: { oldText: "secret old", newText: "secret new" },
					},
				],
			},
			toolResults: [
				{
					toolName: "edit",
					toolCallId: "call-8",
					isError: false,
					content: [{ type: "text", text: "done" }],
					details: { diff: "EDIT_DIFF_MARKER", token: "DETAIL_SECRET" },
				},
			],
		});
		expect(evidence.assistant).toContain("arguments omitted");
		expect(evidence.assistant).not.toContain("secret old");
		expect(evidence.tools[0]).toContain("edit");
		expect(evidence.tools[0]).toContain("call-8");
		expect(evidence.tools[0]).toContain("OK");
		expect(evidence.tools[0]).toContain("EDIT_DIFF_MARKER");
		expect(evidence.tools[0]).not.toContain("DETAIL_SECRET");
	});

	test("ignores diff metadata from non-edit tools", () => {
		const evidence = extractPrimaryTurnEvidence({
			message: {
				role: "assistant",
				content: [{ type: "toolCall", name: "custom", id: "call-custom", arguments: { value: 1 } }],
			},
			toolResults: [
				{
					toolName: "custom",
					toolCallId: "call-custom",
					isError: false,
					content: [{ type: "text", text: "safe result" }],
					details: { diff: "ARBITRARY_SECRET" },
				},
			],
		});
		expect(evidence.assistant).toContain('"value": 1');
		expect(evidence.assistant).not.toContain("arguments omitted");
		expect(evidence.tools[0]).toContain("safe result");
		expect(evidence.tools[0]).not.toContain("ARBITRARY_SECRET");
	});

	test("joins tool evidence before fitting so identities survive a small budget", () => {
		const delta = buildTurnDelta(
			"",
			undefined,
			["TOOL RESULT read (read-1) ERROR\nfailed", "TOOL RESULT edit (edit-1) OK\ndiff"],
			{ contextWindow: 1100, responseReserve: 100 },
		);
		expect(delta.tools).toHaveLength(1);
		expect(delta.tools?.[0]).toContain("TOOL RESULT");
		expect(delta.tools?.[0]).toContain("ERROR");
	});

	test("bounds large tool evidence during extraction", () => {
		const evidence = extractPrimaryTurnEvidence({
			message: { role: "assistant", content: [] },
			toolResults: [
				{
					toolName: "read",
					toolCallId: "large",
					isError: false,
					content: [{ type: "text", text: "x".repeat(100_000) }],
				},
			],
		});
		expect(evidence.tools).toHaveLength(1);
		expect(evidence.tools[0]?.length).toBeLessThan(12_100);
		expect(evidence.tools[0]).toContain("advisor context truncated");
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
	test("removes thinking from resolved bootstrap messages", () => {
		const assistant = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "BOOTSTRAP_THINKING_SECRET" },
				{ type: "text", text: "visible" },
			],
		} as unknown as Message;
		const output = bootstrap([text("user", "prompt"), assistant]);
		expect(JSON.stringify(output)).toContain("visible");
		expect(JSON.stringify(output)).not.toContain("BOOTSTRAP_THINKING_SECRET");
	});

	test("removes arbitrary tool-result metadata from bootstrap", () => {
		const resultWithDetails = {
			...result("c1"),
			details: { token: "BOOTSTRAP_DETAILS_SECRET", diff: "UNTRUSTED_DIFF" },
		} as unknown as Message;
		const output = bootstrap([call("c1"), resultWithDetails]);
		expect(output).toHaveLength(2);
		expect(JSON.stringify(output)).not.toContain("BOOTSTRAP_DETAILS_SECRET");
		expect(JSON.stringify(output)).not.toContain("UNTRUSTED_DIFF");
	});

	test("fits bootstrap by complete tool-pair units", () => {
		const source = [
			text("user", "old ".repeat(2000)),
			text("user", "recent"),
			call("c1"),
			result("c1"),
		];
		const output = bootstrap(source, { contextWindow: 4096, responseReserve: 512 });
		expect(JSON.stringify(output)).toContain("advisor bootstrap context truncated");
		expect(output.at(-2)).toBe(source.at(-2));
		expect(output.at(-1)).toBe(source.at(-1));
		expect(JSON.stringify(output)).not.toContain("old old old");
	});

	test("fails closed when the newest bootstrap unit cannot fit", () => {
		expect(() =>
			bootstrap([text("user", "latest ".repeat(2000))], {
				contextWindow: 1024,
				responseReserve: 256,
			}),
		).toThrow(/cannot fit/i);
	});

	test("filters advisory custom messages before conversion", () => {
		const advisory = {
			role: "custom",
			customType: "pi-basics-advisory",
			content: [],
		} as unknown as Message;
		const source = [text("user", "keep"), advisory, text("assistant", "also keep")];
		expect(bootstrap(source)).toEqual(source.filter((item) => item !== advisory));
	});

	test("drops image-bearing bootstrap messages for text-only Advisor models", () => {
		const imageMessage = {
			role: "user",
			content: [{ type: "image", data: "IMAGE_SECRET", mimeType: "image/png" }],
		} as unknown as Message;
		expect(bootstrap([imageMessage])).toEqual([]);
	});

	test("preserves text from mixed image messages for text-only models", () => {
		const mixed = {
			role: "user",
			content: [
				{ type: "text", text: "keep this task" },
				{ type: "image", data: "IMAGE_SECRET", mimeType: "image/png" },
			],
		} as unknown as Message;
		const output = bootstrap([mixed]);
		expect(JSON.stringify(output)).toContain("keep this task");
		expect(JSON.stringify(output)).not.toContain("IMAGE_SECRET");
	});

	test("preserves complete tool pairs and useful assistant text", () => {
		const source = [text("user", "prompt"), call("c1"), result("c1"), text("assistant", "done")];
		expect(bootstrap(source)).toEqual(source);
	});

	test("drops non-adjacent tool results instead of pairing across messages", () => {
		const assistant = {
			role: "assistant",
			content: [
				{ type: "text", text: "visible answer" },
				{ type: "toolCall", id: "c1", name: "read", arguments: {} },
			],
		} as Message;
		const output = bootstrap([assistant, text("user", "intervening"), result("c1")]);
		expect(output).toHaveLength(2);
		expect(output[0]).toMatchObject({ role: "assistant" });
		expect(JSON.stringify(output)).toContain("visible answer");
		expect(JSON.stringify(output)).not.toContain('"toolCallId":"c1"');
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
