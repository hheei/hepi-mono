import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildHindsightTurns,
	fingerprintTurns,
	MAX_TURN_CHARS,
	renderHindsightTranscript,
	stripMemoryContainers,
} from "../../src/hindsight/transcript.js";

function user(content: string): AgentMessage {
	return { role: "user", content, timestamp: 1 } as UserMessage;
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason,
		timestamp: 2,
	} as AssistantMessage;
}

describe("hindsight transcript extraction", () => {
	it("keeps user and assistant text and drops tool results", () => {
		const messages: AgentMessage[] = [
			user("Fix the parser"),
			assistant([{ type: "text", text: "Looking at it." }]),
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				timestamp: 3,
			} as ToolResultMessage,
		];
		expect(buildHindsightTurns(messages)).toEqual([
			{ role: "user", text: "Fix the parser" },
			{ role: "assistant", text: "Looking at it." },
		]);
	});

	it("summarizes tool calls instead of retaining their arguments verbatim", () => {
		const turns = buildHindsightTurns([
			assistant([
				{
					type: "toolCall",
					id: "c1",
					name: "bash",
					arguments: { command: "pnpm test", cwd: "/repo", timeout: 600 },
				},
			]),
		]);
		expect(turns).toEqual([{ role: "assistant", text: "action: bash pnpm test" }]);
	});

	it("removes injected memory containers so recall cannot feed back", () => {
		const injected = `Do the thing\n\n<memory>\n<!-- … -->\nFrom "Conventions": use pnpm\n</memory>`;
		expect(stripMemoryContainers(injected).trim()).toBe("Do the thing");
		expect(buildHindsightTurns([user(injected)])).toEqual([{ role: "user", text: "Do the thing" }]);
	});

	it("drops failed and aborted assistant responses", () => {
		const turns = buildHindsightTurns([
			assistant([{ type: "text", text: "half an answer" }], "aborted"),
			assistant([{ type: "text", text: "provider blew up" }], "error"),
			assistant([{ type: "text", text: "real answer" }]),
		]);
		expect(turns).toEqual([{ role: "assistant", text: "real answer" }]);
	});

	it("skips empty and non-conversational messages", () => {
		const turns = buildHindsightTurns([
			user("   "),
			assistant([{ type: "thinking", thinking: "internal" }]),
			assistant([]),
		]);
		expect(turns).toEqual([]);
	});

	it("represents images and bounds oversized turns", () => {
		const imageOnly = {
			role: "user",
			content: [{ type: "image", data: "…", mimeType: "image/png" }],
			timestamp: 1,
		} as UserMessage;
		expect(buildHindsightTurns([imageOnly])).toEqual([{ role: "user", text: "[image]" }]);

		const long = buildHindsightTurns([user("x".repeat(MAX_TURN_CHARS * 2))]);
		expect(long[0]?.text.length).toBe(MAX_TURN_CHARS);
	});

	it("renders a transcript body and fingerprints it stably", () => {
		const turns = buildHindsightTurns([user("hello"), assistant([{ type: "text", text: "hi" }])]);
		expect(renderHindsightTranscript(turns)).toBe("User: hello\n\nAssistant: hi");
		expect(fingerprintTurns(turns)).toBe(fingerprintTurns(turns));
		expect(fingerprintTurns(turns)).toBe(fingerprintTurns([...turns]));
		expect(fingerprintTurns(turns)).not.toBe(
			fingerprintTurns([
				{ role: "user", text: "hello" },
				{ role: "assistant", text: "hi!" },
			]),
		);
		// The fingerprint covers the retained prefix only.
		expect(fingerprintTurns(turns, 1)).not.toBe(fingerprintTurns(turns));
	});
});
