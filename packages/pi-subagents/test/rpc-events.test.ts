import { describe, expect, test } from "vitest";
import { isIdlePiState, shouldForwardPiEvent } from "../src/rpc-events.js";

describe("rpc event filter", () => {
	test("forwards turn and tool boundaries and drops partial noise", () => {
		expect(shouldForwardPiEvent({ type: "turn_end" })).toBe(true);
		expect(shouldForwardPiEvent({ type: "agent_start" })).toBe(true);
		expect(shouldForwardPiEvent({ type: "message_update" })).toBe(true);
		expect(shouldForwardPiEvent({ type: "noise", index: 0 })).toBe(false);
		expect(shouldForwardPiEvent({ type: "message_start" })).toBe(false);
		expect(shouldForwardPiEvent("turn_end")).toBe(false);
	});

	test("treats a complete idle get_state as idle", () => {
		expect(isIdlePiState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 })).toBe(
			true,
		);
		expect(isIdlePiState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 })).toBe(
			false,
		);
		expect(isIdlePiState({ isStreaming: false, isCompacting: false, pendingMessageCount: 1 })).toBe(
			false,
		);
	});
});
