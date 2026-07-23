import { describe, expect, test } from "bun:test";
import {
	buildPonytailPrompt,
	detectPonytailDeactivation,
	PONYTAIL_STATE_ENTRY,
	parsePonytailCommand,
	restorePonytailMode,
} from "../src/index.js";

describe("Ponytail mode", () => {
	test("parses runtime modes without treating skills as commands", () => {
		expect(parsePonytailCommand("")).toEqual({ kind: "set", mode: "full" });
		expect(parsePonytailCommand("ultra")).toEqual({ kind: "set", mode: "ultra" });
		expect(parsePonytailCommand("off")).toEqual({ kind: "set", mode: "off" });
		expect(parsePonytailCommand("status")).toEqual({ kind: "status" });
		expect(parsePonytailCommand("review")).toEqual({ kind: "invalid", value: "review" });
	});

	test("only recognizes standalone deactivation phrases", () => {
		expect(detectPonytailDeactivation("normal mode")).toBeTrue();
		expect(detectPonytailDeactivation("Stop Ponytail!")).toBeTrue();
		expect(detectPonytailDeactivation("add a normal mode toggle")).toBeFalse();
	});

	test("restores the latest valid branch state", () => {
		const entries = [
			{ type: "custom", customType: PONYTAIL_STATE_ENTRY, data: { version: 1, mode: "lite" } },
			{ type: "custom", customType: PONYTAIL_STATE_ENTRY, data: { version: 1, mode: "bad" } },
			{ type: "custom", customType: PONYTAIL_STATE_ENTRY, data: { version: 1, mode: "ultra" } },
		];
		expect(restorePonytailMode(entries)).toBe("ultra");
		expect(restorePonytailMode([], "off")).toBe("off");
	});

	test("builds level-specific instructions", () => {
		expect(buildPonytailPrompt("full")).toContain("Current level: full");
		expect(buildPonytailPrompt("full")).toContain("standard library");
		expect(buildPonytailPrompt("ultra")).toContain("strict YAGNI");
		expect(buildPonytailPrompt("off")).toBeUndefined();
	});
});
