import { beforeEach, describe, expect, it } from "vitest";
import {
	getDefaultMaxTurns,
	getGraceTurns,
	normalizeMaxTurns,
	setDefaultMaxTurns,
	setGraceTurns,
} from "../src/agent-runner.js";

describe("core-owned turn limits", () => {
	beforeEach(() => {
		setDefaultMaxTurns(50);
		setGraceTurns(1_000);
	});

	it("keeps a finite positive default", () => {
		setDefaultMaxTurns(30);
		expect(getDefaultMaxTurns()).toBe(30);
		setDefaultMaxTurns(0);
		setDefaultMaxTurns(-1);
		expect(getDefaultMaxTurns()).toBe(30);
	});

	it("normalizes omitted and invalid values to a finite positive limit", () => {
		expect(normalizeMaxTurns(undefined)).toBe(50);
		expect(normalizeMaxTurns(7.9)).toBe(1);
		expect(normalizeMaxTurns(0)).toBe(1);
		expect(normalizeMaxTurns(-3)).toBe(1);
		expect(normalizeMaxTurns(Number.NaN)).toBe(1);
	});

	it("does not allow callers to change the fixed grace", () => {
		expect(getGraceTurns()).toBe(5);
	});
});
