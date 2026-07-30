import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isHepiSubagentSession,
	type PiSubagentSessionBridge,
} from "../../../src/core/runtime/subagent-session.js";

afterEach(() => {
	globalThis.__piSubagentSessionBridgesByRuntime = undefined;
});

function pi(events: object): ExtensionAPI {
	return { events } as ExtensionAPI;
}

test("reports a Pi Subagents child only for its runtime bridge", () => {
	const childEvents = {};
	const parentEvents = {};
	const bridges = new WeakMap<object, PiSubagentSessionBridge>();
	bridges.set(childEvents, { isSubagentSession: () => true });
	bridges.set(parentEvents, { isSubagentSession: () => false });
	globalThis.__piSubagentSessionBridgesByRuntime = bridges;

	expect(isHepiSubagentSession(pi(childEvents))).toBe(true);
	expect(isHepiSubagentSession(pi(parentEvents))).toBe(false);
});

test("reports false when Pi Subagents is not loaded", () => {
	expect(isHepiSubagentSession(pi({}))).toBe(false);
});
