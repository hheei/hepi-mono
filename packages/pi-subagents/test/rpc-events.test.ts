import { describe, expect, test } from "vitest";
import { shouldForwardPiEvent } from "../src/rpc-events.js";

describe("rpc event filter", () => {
	test("forwards turn and tool boundaries and drops partial noise", () => {
		expect(shouldForwardPiEvent({ type: "turn_end" })).toBe(true);
		expect(shouldForwardPiEvent({ type: "agent_start" })).toBe(true);
		expect(shouldForwardPiEvent({ type: "message_update" })).toBe(true);
		expect(shouldForwardPiEvent({ type: "noise", index: 0 })).toBe(false);
		expect(shouldForwardPiEvent({ type: "message_start" })).toBe(false);
		expect(shouldForwardPiEvent("turn_end")).toBe(false);
	});
});
