import type { ConversationSubagentHandle } from "@hheei/pi-ext-core";
import { describe, expect, it, vi } from "vitest";
import {
	getDefaultMaxTurns,
	getGraceTurns,
	normalizeMaxTurns,
	setDefaultMaxTurns,
	setGraceTurns,
	steerAgent,
} from "../src/agent-runner.js";

describe("core-backed runner policy", () => {
	it("keeps the default max-turn budget finite", () => {
		expect(getDefaultMaxTurns()).toBeGreaterThan(0);
		expect(normalizeMaxTurns(undefined)).toBe(getDefaultMaxTurns());
		expect(normalizeMaxTurns(12.9)).toBe(1);
	});

	it("accepts a finite default max-turn budget", () => {
		const before = getDefaultMaxTurns();
		setDefaultMaxTurns(42);
		expect(getDefaultMaxTurns()).toBe(42);
		setDefaultMaxTurns(before);
	});

	it("keeps the core-owned grace period fixed at five turns", () => {
		setGraceTurns(99);
		expect(getGraceTurns()).toBe(5);
	});

	it("delegates steering to the opaque conversation handle", async () => {
		const steer = vi.fn(async () => undefined);
		await steerAgent({ steer } as unknown as ConversationSubagentHandle, "focus on tests");
		expect(steer).toHaveBeenCalledWith("focus on tests");
	});
});
