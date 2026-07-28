import { describe, expect, test } from "bun:test";
import type { AftProjectTransport, ToolCallResult } from "@cortexkit/aft-bridge";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callToolCall } from "../src/aft/shared.js";

const context = {
	sessionManager: { getSessionId: () => "session-1" },
} as unknown as ExtensionContext;

function bridge(toolCall: AftProjectTransport["toolCall"]): AftProjectTransport {
	return { toolCall } as AftProjectTransport;
}

describe("AFT tool-call timeout recovery", () => {
	test("retries a timed-out read once", async () => {
		let calls = 0;
		const result = await callToolCall(
			bridge(async (): Promise<ToolCallResult> => {
				calls++;
				if (calls === 1)
					throw new Error('[aft-bridge] Request "tool_call" timed out after 10000ms');
				return { success: true, text: "contents" };
			}),
			"read",
			{ path: "src/example.ts" },
			context,
		);

		expect(calls).toBe(2);
		expect(result.text).toBe("contents");
	});

	test("does not retry a timed-out apply_patch", async () => {
		let calls = 0;
		await expect(
			callToolCall(
				bridge(async (): Promise<ToolCallResult> => {
					calls++;
					throw new Error('[aft-bridge] Request "tool_call" timed out after 10000ms');
				}),
				"apply_patch",
				{ patchText: "*** Begin Patch\n*** End Patch" },
				context,
			),
		).rejects.toThrow("timed out after");

		expect(calls).toBe(1);
	});
});
