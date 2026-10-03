import { describe, expect, test } from "vitest";
import { type ChildIdentity, PROTOCOL_VERSION } from "../src/domain.js";
import {
	BRIDGE_OPERATIONS,
	CHILD_INPUT_EVENT,
	CHILD_LIFECYCLE_EVENT,
	DEFAULT_MAX_BUFFERED_EVENTS,
	DEFAULT_MAX_FRAME_BYTES,
	DEFAULT_MAX_PENDING_REQUESTS,
	eventFrame,
	failureResponse,
	isEventFrame,
	isHelloAckFrame,
	isHelloFrame,
	isRequestFrame,
	isResponseFrame,
	successResponse,
} from "../src/protocol.js";

const identity: ChildIdentity = {
	parentSessionId: "parent-1",
	subagentId: "child-1",
	runtimeIdentity: "runtime-1",
	endpoint: "/tmp/runner.sock",
	token: "secret",
};

const hello = { version: PROTOCOL_VERSION, type: "hello", ...identity };

describe("bridge protocol frames", () => {
	test("accepts a complete hello frame and rejects incomplete ones", () => {
		expect(isHelloFrame(hello)).toBe(true);
		expect(isHelloFrame({ ...hello, role: "child" })).toBe(true);
		expect(isHelloFrame({ ...hello, role: "controller" })).toBe(false);
		const { endpoint: _endpoint, ...withoutEndpoint } = hello;
		expect(isHelloFrame(withoutEndpoint)).toBe(false);
		expect(isHelloFrame({ ...hello, version: PROTOCOL_VERSION + 1 })).toBe(false);
		expect(isHelloFrame({ ...hello, token: "" })).toBe(false);
		expect(isHelloFrame({ ...hello, extra: true })).toBe(false);
		expect(isHelloFrame("hello")).toBe(false);
		expect(isHelloFrame(undefined)).toBe(false);
	});

	test("accepts only the bare hello_ack frame", () => {
		expect(isHelloAckFrame({ version: PROTOCOL_VERSION, type: "hello_ack" })).toBe(true);
		expect(isHelloAckFrame({ version: PROTOCOL_VERSION, type: "hello_ack", data: {} })).toBe(false);
		expect(isHelloAckFrame({ version: PROTOCOL_VERSION, type: "hello" })).toBe(false);
	});

	test("accepts every declared operation and rejects unknown ones", () => {
		for (const operation of BRIDGE_OPERATIONS) {
			expect(
				isRequestFrame({ version: PROTOCOL_VERSION, type: "request", id: "1", operation }),
			).toBe(true);
		}
		expect(
			isRequestFrame({ version: PROTOCOL_VERSION, type: "request", id: "1", operation: "resume" }),
		).toBe(false);
		expect(
			isRequestFrame({ version: PROTOCOL_VERSION, type: "request", operation: "prompt" }),
		).toBe(false);
		expect(
			isRequestFrame({
				version: PROTOCOL_VERSION,
				type: "request",
				id: "1",
				operation: "prompt",
				extra: true,
			}),
		).toBe(false);
	});

	test("keeps data and error mutually exclusive on responses", () => {
		expect(isResponseFrame(successResponse("1", { answer: 42 }))).toBe(true);
		expect(isResponseFrame(successResponse("1"))).toBe(true);
		expect(isResponseFrame(failureResponse("1", "timeout", "too slow"))).toBe(true);
		expect(
			isResponseFrame({
				version: PROTOCOL_VERSION,
				type: "response",
				id: "1",
				ok: false,
				error: { code: "timeout" },
			}),
		).toBe(false);
		expect(
			isResponseFrame({
				version: PROTOCOL_VERSION,
				type: "response",
				id: "1",
				ok: true,
				error: { code: "timeout", message: "too slow" },
			}),
		).toBe(false);
		expect(
			isResponseFrame({
				version: PROTOCOL_VERSION,
				type: "response",
				id: "1",
				ok: false,
				error: { code: "timeout", message: "too slow" },
			}),
		).toBe(true);
	});

	test("carries opaque event payloads", () => {
		expect(isEventFrame(eventFrame({ type: "agent_start" }))).toBe(true);
		expect(isEventFrame(eventFrame(undefined))).toBe(true);
		expect(isEventFrame({ version: PROTOCOL_VERSION, type: "event" })).toBe(false);
		expect(isEventFrame({ version: PROTOCOL_VERSION, type: "event", event: 1, extra: 2 })).toBe(
			false,
		);
	});

	test("exports bounded defaults for frames, pending requests and buffered events", () => {
		expect(DEFAULT_MAX_FRAME_BYTES).toBe(1024 * 1024);
		expect(DEFAULT_MAX_PENDING_REQUESTS).toBeGreaterThan(0);
		expect(DEFAULT_MAX_BUFFERED_EVENTS).toBeGreaterThan(0);
		expect(CHILD_LIFECYCLE_EVENT).toBe("child_lifecycle");
		expect(CHILD_INPUT_EVENT).toBe("child_input");
	});
});
