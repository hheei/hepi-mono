import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../extensions/config/config.js";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "pi-hindsight-"));
}

function writeSettings(cwd: string, config: Record<string, unknown>): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-hindsight": config }));
}

describe("settings.json config resolution", () => {
	it("reads only the pi-hindsight project section", () => {
		const cwd = tmp();
		writeSettings(cwd, { recall: { maxTokens: 123 }, banks: { project: { bankId: "bank" } } });

		const config = resolveConfig(cwd, {});

		expect(config.recall.maxTokens).toBe(123);
		expect(config.banks.project.bankId).toBe("bank");
	});

	it("ignores the removed hindsight.json file", () => {
		const cwd = tmp();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "hindsight.json"),
			JSON.stringify({ recall: { maxTokens: 123 } }),
		);

		expect(resolveConfig(cwd, {}).recall.maxTokens).toBe(800);
	});

	it("merges agent settings before project settings", () => {
		const cwd = tmp();
		const agentDir = tmp();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ "pi-hindsight": { recall: { budget: "low", maxTokens: 300 } } }),
		);
		writeSettings(cwd, { recall: { maxTokens: 700 } });

		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const config = resolveConfig(cwd, {});
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;

		expect(config.recall.budget).toBe("low");
		expect(config.recall.maxTokens).toBe(700);
	});

	it("applies environment overrides after settings", () => {
		const cwd = tmp();
		writeSettings(cwd, { enabled: false, hindsight: { baseUrl: "http://stored" } });

		const config = resolveConfig(cwd, {
			PI_HINDSIGHT_ENABLED: "true",
			HINDSIGHT_BASE_URL: "http://env",
		});

		expect(config.enabled).toBe(true);
		expect(config.hindsight.baseUrl).toBe("http://env");
	});
});
