import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => mock.agentDir,
}));

import {
	type Config,
	DEFAULTS,
	loadConfig,
	MAX_TIMEOUT_SECONDS,
	parseDurationToSeconds,
	readEnvConfig,
	resolveCompactAfterTokens,
} from "../src/config.js";

function writeJson(path: string, value: unknown) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value), "utf-8");
}

describe("V3 config", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = `${tmpdir()}/om-v3-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mock.agentDir = agentDir;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("uses V3 defaults", async () => {
		expect(DEFAULTS).toEqual({
			observeAfterTokens: 10000,
			reflectAfterTokens: 20000,
			compactAfterTokens: 81000,
			compactAfterTokensMode: "calibrated",
			compactAfterTokensRatio: 0.68,
			idleCompactionTtlSeconds: 1800,
			idleCompactionMinTokens: 75_000,
			observationsPoolMaxTokens: 20000,
			observationsPoolTargetTokens: 10000,
			agentMaxTurns: 16,
			agentMaxTokens: 32000,
			showWorkerNotifications: true,
			passive: false,
			debugLog: false,
		});
		expect(await loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("merges global, project, and env V3 settings in order", async () => {
		writeJson(join(agentDir, "ext_settings.json"), {
			"observational-memory": {
				observeAfterTokens: 10,
				reflectAfterTokens: 20,
				compactAfterTokens: 30,
				observationsPoolMaxTokens: 40,
				observationsPoolTargetTokens: 15,
				agentMaxTurns: 5,
				agentMaxTokens: 8192,
				model: { provider: "anthropic", id: "global", thinking: "medium" },
				showWorkerNotifications: true,
				passive: false,
				debugLog: true,
			},
		});
		writeJson(join(cwd, ".pi", "ext_settings.json"), {
			"observational-memory": {
				observeAfterTokens: 100,
				model: { provider: "openai", id: "project", thinking: "low" },
				showWorkerNotifications: false,
			},
		});

		expect(await loadConfig(cwd, { PI_OBSERVATIONAL_MEMORY_PASSIVE: "true" })).toMatchObject({
			observeAfterTokens: 100,
			reflectAfterTokens: 20,
			compactAfterTokens: 30,
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 15,
			agentMaxTurns: 5,
			agentMaxTokens: 8192,
			model: { provider: "openai", id: "project", thinking: "low" },
			showWorkerNotifications: false,
			passive: true,
			debugLog: true,
		});
	});

	it("accepts max as a valid model thinking level", async () => {
		writeJson(join(cwd, ".pi", "ext_settings.json"), {
			"observational-memory": {
				model: { provider: "anthropic", id: "claude", thinking: "max" },
			},
		});

		expect(await loadConfig(cwd, {})).toMatchObject({
			model: { provider: "anthropic", id: "claude", thinking: "max" },
		});
	});

	it("ignores invalid V3 values", async () => {
		writeJson(join(cwd, ".pi", "ext_settings.json"), {
			"observational-memory": {
				observeAfterTokens: -1,
				reflectAfterTokens: 0,
				compactAfterTokens: 1.5,
				observationsPoolMaxTokens: "20000",
				observationsPoolTargetTokens: "10000",
				agentMaxTurns: null,
				model: { provider: "anthropic", id: "", thinking: "huge" },
				showWorkerNotifications: "no",
				passive: "yes",
				debugLog: "true",
			},
		});

		expect(await loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("derives observation pool target from the final max when omitted", async () => {
		writeJson(join(cwd, ".pi", "ext_settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 40,
			},
		});

		expect(await loadConfig(cwd, {})).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("falls back to derived target when explicit target is invalid for the final max", async () => {
		writeJson(join(agentDir, "ext_settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 100,
				observationsPoolTargetTokens: 80,
			},
		});
		writeJson(join(cwd, ".pi", "ext_settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 40,
			},
		});

		expect(await loadConfig(cwd, {})).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("ignores old V2 settings without warnings or aliases", async () => {
		writeJson(join(cwd, ".pi", "ext_settings.json"), {
			"observational-memory": {
				observationThresholdTokens: 10,
				compactionThresholdTokens: 20,
				reflectionThresholdTokens: 30,
				compactionModel: { provider: "anthropic", id: "old" },
				thinkingLevel: "high",
				observerMaxTurnsPerRun: 2,
				reflectorMaxTurnsPerPass: 3,
				prunerMaxTurnsPerPass: 4,
				compactionMaxToolCalls: 5,
			},
		});

		expect(await loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("strictly ignores legacy settings.json without fallback compatibility", async () => {
		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": {
				observeAfterTokens: 99,
				model: { provider: "anthropic", id: "legacy" },
			},
		});
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observeAfterTokens: 88,
				model: { provider: "openai", id: "legacy" },
			},
		});

		expect(await loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("parses passive env override", () => {
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "on" })).toEqual({ passive: true });
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "0" })).toEqual({ passive: false });
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "maybe" })).toEqual({});
	});

	describe("compactAfterTokens ratio mode", () => {
		it("accepts compactAfterTokensMode and compactAfterTokensRatio", async () => {
			writeJson(join(cwd, ".pi", "ext_settings.json"), {
				"observational-memory": {
					compactAfterTokensMode: "ratio",
					compactAfterTokensRatio: 0.5,
				},
			});

			expect(await loadConfig(cwd, {})).toMatchObject({
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
		});

		it("rejects invalid mode values and falls back to default calibrated", async () => {
			writeJson(join(cwd, ".pi", "ext_settings.json"), {
				"observational-memory": {
					compactAfterTokensMode: "auto",
				},
			});

			expect(await loadConfig(cwd, {})).toMatchObject({ compactAfterTokensMode: "calibrated" });
		});

		it("rejects ratio outside (0, 1) and falls back to default", async () => {
			writeJson(join(cwd, ".pi", "ext_settings.json"), {
				"observational-memory": {
					compactAfterTokensRatio: 0,
				},
			});
			expect(await loadConfig(cwd, {})).toMatchObject({ compactAfterTokensRatio: 0.68 });

			writeJson(join(cwd, ".pi", "ext_settings.json"), {
				"observational-memory": {
					compactAfterTokensRatio: 1,
				},
			});
			expect(await loadConfig(cwd, {})).toMatchObject({ compactAfterTokensRatio: 0.68 });

			writeJson(join(cwd, ".pi", "ext_settings.json"), {
				"observational-memory": {
					compactAfterTokensRatio: 1.5,
				},
			});
			expect(await loadConfig(cwd, {})).toMatchObject({ compactAfterTokensRatio: 0.68 });

			writeJson(join(cwd, ".pi", "ext_settings.json"), {
				"observational-memory": {
					compactAfterTokensRatio: -0.2,
				},
			});
			expect(await loadConfig(cwd, {})).toMatchObject({ compactAfterTokensRatio: 0.68 });
		});

		it("rejects non-numeric ratio and falls back to default", async () => {
			writeJson(join(cwd, ".pi", "ext_settings.json"), {
				"observational-memory": {
					compactAfterTokensRatio: "0.5",
				},
			});
			expect(await loadConfig(cwd, {})).toMatchObject({ compactAfterTokensRatio: 0.68 });
		});
	});

	describe("resolveCompactAfterTokens", () => {
		it("returns the calibrated value in calibrated mode", () => {
			const config: Config = {
				...DEFAULTS,
				compactAfterTokensMode: "calibrated",
				compactAfterTokens: 81000,
			};
			expect(resolveCompactAfterTokens(config, 1_000_000)).toBe(81000);
		});

		it("returns calibrated value regardless of context window in calibrated mode", () => {
			const config: Config = {
				...DEFAULTS,
				compactAfterTokensMode: "calibrated",
				compactAfterTokens: 81000,
			};
			expect(resolveCompactAfterTokens(config, undefined)).toBe(81000);
			expect(resolveCompactAfterTokens(config, 0)).toBe(81000);
		});

		it("scales by context window in ratio mode", () => {
			const config: Config = {
				...DEFAULTS,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
				compactAfterTokens: 81000,
			};
			expect(resolveCompactAfterTokens(config, 1_000_000)).toBe(500_000);
			expect(resolveCompactAfterTokens(config, 200_000)).toBe(100_000);
		});

		it("floors fractional results to an integer >= 1", () => {
			const config: Config = {
				...DEFAULTS,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
				compactAfterTokens: 81000,
			};
			expect(resolveCompactAfterTokens(config, 3)).toBe(1);
			expect(resolveCompactAfterTokens(config, 1)).toBe(1);
		});

		it("falls back to calibrated value when context window is unavailable in ratio mode", () => {
			const config: Config = {
				...DEFAULTS,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
				compactAfterTokens: 81000,
			};
			expect(resolveCompactAfterTokens(config, undefined)).toBe(81000);
			expect(resolveCompactAfterTokens(config, 0)).toBe(81000);
			expect(resolveCompactAfterTokens(config, -1)).toBe(81000);
		});
	});

	describe("parseDurationToSeconds", () => {
		it("parses valid unit duration strings", () => {
			expect(parseDurationToSeconds("30m")).toBe(30 * 60);
			expect(parseDurationToSeconds("5m")).toBe(5 * 60);
			expect(parseDurationToSeconds("1h")).toBe(60 * 60);
			expect(parseDurationToSeconds("1.5h")).toBe(90 * 60);
			expect(parseDurationToSeconds("300s")).toBe(300);
			expect(parseDurationToSeconds("2d")).toBe(2 * 24 * 60 * 60);
		});

		it("parses numeric strings and numbers as seconds", () => {
			expect(parseDurationToSeconds("60")).toBe(60);
			expect(parseDurationToSeconds(120)).toBe(120);
			expect(parseDurationToSeconds("1800")).toBe(1800);
			expect(parseDurationToSeconds(1800)).toBe(1800);
			expect(parseDurationToSeconds(0.5)).toBe(DEFAULTS.idleCompactionTtlSeconds);
		});

		it("disables on explicit disable values", () => {
			expect(parseDurationToSeconds(false)).toBeUndefined();
			expect(parseDurationToSeconds(0)).toBeUndefined();
			expect(parseDurationToSeconds("")).toBeUndefined();
			expect(parseDurationToSeconds("never")).toBeUndefined();
			expect(parseDurationToSeconds("NEVER")).toBeUndefined();
		});

		it("falls back to fallbackSeconds on unrecognized formats or negative numbers", () => {
			expect(parseDurationToSeconds("invalid")).toBe(DEFAULTS.idleCompactionTtlSeconds);
			expect(parseDurationToSeconds(-100)).toBe(DEFAULTS.idleCompactionTtlSeconds);
			expect(parseDurationToSeconds("foo5m")).toBe(DEFAULTS.idleCompactionTtlSeconds);
			expect(parseDurationToSeconds(true)).toBe(DEFAULTS.idleCompactionTtlSeconds);
		});

		it("falls back to fallbackSeconds when duration exceeds Node setTimeout limit MAX_TIMEOUT_SECONDS", () => {
			expect(parseDurationToSeconds(MAX_TIMEOUT_SECONDS + 1)).toBe(
				DEFAULTS.idleCompactionTtlSeconds,
			);
			expect(parseDurationToSeconds("9999999999999")).toBe(DEFAULTS.idleCompactionTtlSeconds);
			expect(parseDurationToSeconds("3000d")).toBe(DEFAULTS.idleCompactionTtlSeconds);
		});
	});

	describe("idle compaction config loading", () => {
		it("loads custom idleCompaction settings", async () => {
			writeJson(join(cwd, ".pi", "ext_settings.json"), {
				"observational-memory": {
					idleCompactionTtl: "1h",
					idleCompactionMinTokens: 50_000,
				},
			});
			const config = await loadConfig(cwd, {});
			expect(config.idleCompactionTtlSeconds).toBe(3600);
			expect(config.idleCompactionMinTokens).toBe(50_000);
		});

		it("disables idle compaction when configured with never or false", async () => {
			writeJson(join(cwd, ".pi", "ext_settings.json"), {
				"observational-memory": {
					idleCompactionTtl: "never",
				},
			});
			const config = await loadConfig(cwd, {});
			expect(config.idleCompactionTtlSeconds).toBeUndefined();
		});
	});
});
