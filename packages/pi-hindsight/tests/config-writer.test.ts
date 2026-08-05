import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildProjectConfigDeletes,
	buildProjectConfigPatch,
	globalConfigPath,
	projectConfigPath,
	readGlobalConfig,
	readProjectConfig,
	writeGlobalConfig,
	writeProjectConfig,
} from "../extensions/config/config-writer.js";

describe("settings.json config writer", () => {
	it("writes project config under the pi-hindsight section", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-config-"));
		const result = await writeProjectConfig(
			cwd,
			buildProjectConfigPatch({ projectBankId: "bank" }),
		);

		expect(result.path).toBe(projectConfigPath(cwd));
		expect(JSON.parse(readFileSync(result.path, "utf8"))).toMatchObject({
			"pi-hindsight": { banks: { project: { bankId: "bank", derive: "manual" } } },
		});
	});

	it("preserves sibling settings sections", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-config-"));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ "pi-ponytail": { x: true } }),
		);

		await writeProjectConfig(cwd, buildProjectConfigPatch({ recallBudget: "high" }));

		expect(JSON.parse(readFileSync(projectConfigPath(cwd), "utf8"))).toMatchObject({
			"pi-ponytail": { x: true },
			"pi-hindsight": { recall: { budget: "high" } },
		});
	});

	it("writes global config into the user settings section", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-hindsight-agent-"));
		await writeGlobalConfig(buildProjectConfigPatch({ baseUrl: "http://global" }), [], agentDir);

		expect(readGlobalConfig(agentDir)).toMatchObject({ hindsight: { baseUrl: "http://global" } });
		expect(JSON.parse(readFileSync(globalConfigPath(agentDir), "utf8"))).toHaveProperty(
			"pi-hindsight",
		);
	});

	it("removes selected project overrides without deleting the settings section", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-config-"));
		await writeProjectConfig(
			cwd,
			buildProjectConfigPatch({ projectBankId: "bank", recallBudget: "high" }),
		);
		await writeProjectConfig(
			cwd,
			{},
			buildProjectConfigDeletes({ resetDefaults: ["banks.project.bankId", "recall.budget"] }),
		);

		expect(readProjectConfig(cwd)).toMatchObject({ banks: { project: {} }, recall: {} });
	});
});
