import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRtkConfig, saveRtkConfig, settingsPath } from "../../src/rtk/rtk/config.js";
import { DEFAULT_RTK_INTEGRATION_CONFIG } from "../../src/rtk/rtk/types.js";

describe("RTK global settings", () => {
	test("round-trips the global section without replacing sibling settings", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-rtk-settings-"));
		const path = join(agentDir, "settings.json");
		await writeFile(
			path,
			JSON.stringify({ theme: "dark", hepi: { advisor: { thinking: "high" } } }),
		);
		const config = { ...DEFAULT_RTK_INTEGRATION_CONFIG, mode: "suggest" as const };

		await saveRtkConfig(config, agentDir);

		expect(settingsPath(agentDir)).toBe(path);
		expect((await loadRtkConfig(agentDir)).config.mode).toBe("suggest");
		const root: unknown = JSON.parse(await readFile(path, "utf8"));
		expect(root).toMatchObject({
			theme: "dark",
			hepi: {
				advisor: { thinking: "high" },
				rtk: { mode: "suggest" },
			},
		});
	});
});
