import { describe, expect, test } from "vitest";
import { PauseGate } from "../src/pause-gate.js";

describe("pause gate", () => {
	test("wait resolves immediately when nothing is holding", async () => {
		const gate = new PauseGate();
		await expect(gate.wait()).resolves.toBeUndefined();
		expect(gate.holding).toBe(false);
	});

	test("request holds turn_end until cancel", async () => {
		const gate = new PauseGate();
		gate.request(1);
		expect(gate.holding).toBe(true);
		expect(gate.generation).toBe(1);
		let released = false;
		const held = gate.wait().then(() => {
			released = true;
		});
		await Promise.resolve();
		expect(released).toBe(false);
		gate.cancel(1);
		await held;
		expect(released).toBe(true);
		expect(gate.holding).toBe(false);
	});

	test("ignores a stale pause generation", () => {
		const gate = new PauseGate();
		gate.request(4);
		gate.request(3);
		expect(gate.generation).toBe(4);
		expect(gate.holding).toBe(true);
		gate.cancel(2);
		expect(gate.holding).toBe(true);
		gate.cancel(5);
		expect(gate.holding).toBe(false);
		expect(gate.generation).toBe(5);
	});

	test("abort releases the hold", async () => {
		const gate = new PauseGate();
		gate.request(1);
		const abort = new AbortController();
		const held = gate.wait(abort.signal);
		abort.abort();
		await expect(held).resolves.toBeUndefined();
		expect(gate.holding).toBe(false);
	});
});
