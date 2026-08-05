import { describe, expect, test } from "bun:test";
import {
	buildCavemanPrompt,
	cavemanStatusLabel,
	detectCavemanIntent,
	parseCavemanCommand,
	restoreCavemanMode,
} from "../../src/index.js";

describe("caveman mode parsing", () => {
	test("parses modes, aliases, and control commands", () => {
		expect(parseCavemanCommand("")).toEqual({ kind: "set", mode: "full" });
		expect(parseCavemanCommand(" ultra ")).toEqual({ kind: "set", mode: "ultra" });
		expect(parseCavemanCommand("wenyan")).toEqual({ kind: "set", mode: "wenyan-full" });
		expect(parseCavemanCommand("normal")).toEqual({ kind: "set", mode: "off" });
		expect(parseCavemanCommand("status")).toEqual({ kind: "status" });
		expect(parseCavemanCommand("loud")).toEqual({ kind: "invalid", value: "loud" });
	});

	test("detects natural-language activation and deactivation", () => {
		expect(detectCavemanIntent("Please talk like caveman for this session")).toBe("full");
		expect(detectCavemanIntent("turn on the caveman mode")).toBe("full");
		expect(detectCavemanIntent("use ultra caveman mode")).toBe("ultra");
		expect(detectCavemanIntent("talk like caveman wenyan")).toBe("wenyan-full");
		expect(detectCavemanIntent("normal mode please")).toBe("off");
		expect(detectCavemanIntent("What does 'normal mode' mean?")).toBeUndefined();
		expect(detectCavemanIntent("explain the Caveman repository")).toBeUndefined();
	});
});

describe("caveman session state", () => {
	test("restores the latest valid state on the active branch", () => {
		const entries = [
			{ type: "custom", customType: "pi-caveman-state", data: { version: 1, mode: "lite" } },
			{ type: "custom", customType: "other", data: { version: 1, mode: "off" } },
			{ type: "custom", customType: "pi-caveman-state", data: { version: 1, mode: "ultra" } },
		];
		expect(restoreCavemanMode(entries)).toBe("ultra");
	});

	test("defaults to full when no valid state exists", () => {
		expect(restoreCavemanMode([])).toBe("full");
		expect(
			restoreCavemanMode([
				{ type: "custom", customType: "pi-caveman-state", data: { version: 1, mode: "invalid" } },
			]),
		).toBe("full");
	});
});

describe("caveman prompt", () => {
	test("builds mode-specific instructions", () => {
		const prompt = buildCavemanPrompt("wenyan-full");
		expect(prompt).toContain("Current intensity: wenyan-full");
		expect(prompt).toContain("classical Chinese");
		expect(prompt).toContain("irreversible-action confirmations");
	});

	test("does not inject instructions while off", () => {
		expect(buildCavemanPrompt("off")).toBeUndefined();
		expect(cavemanStatusLabel("off")).toBeUndefined();
		expect(cavemanStatusLabel("full")).toBe("caveman");
	});
});
