import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { replayTui, stripAnsi } from "../../hepi-debug/src/tui-replay.js";
import {
	AFT_BINARY_SETTINGS_GROUP,
	aftBinarySettings,
	createAftBinarySettingsProvider,
	DEFAULT_AFT_BINARY_SETTINGS,
	loadAftBinarySettings,
} from "../src/core/index.js";
import { createSettingsComponent } from "../src/core/ui/settings/component.js";
import { createSettingsController } from "../src/core/ui/settings/controller.js";
import { fakeTheme, testContext } from "./helpers.js";

const context = { sessionId: "aft-settings-test", cwd: "/tmp" };

describe("AFT binary settings", () => {
	test("defaults to the official binary resolver with an empty path", () => {
		expect(aftBinarySettings({})).toEqual(DEFAULT_AFT_BINARY_SETTINGS);
	});

	test("persists a local absolute binary path without overwriting sibling settings", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-basics-aft-"));
		const path = join(directory, "settings.json");
		await Bun.write(path, JSON.stringify({ hepi: { retry: { enabled: true } } }));
		const provider = createAftBinarySettingsProvider({ path });
		await provider.storage.save(
			{ [AFT_BINARY_SETTINGS_GROUP]: { binaryPath: "/opt/aft/bin/aft" } },
			context,
		);
		expect(await provider.storage.load(context)).toEqual({
			[AFT_BINARY_SETTINGS_GROUP]: { binaryPath: "/opt/aft/bin/aft" },
		});
		expect(await loadAftBinarySettings(context, { path })).toEqual({
			binaryPath: "/opt/aft/bin/aft",
		});
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			hepi: {
				retry: { enabled: true },
				aft: { binaryPath: "/opt/aft/bin/aft" },
			},
		});
	});

	test("accepts an empty path and requires non-empty paths to be absolute", async () => {
		const provider = createAftBinarySettingsProvider();
		await expect(
			provider.storage.validate?.({ [AFT_BINARY_SETTINGS_GROUP]: { binaryPath: "aft" } }, context),
		).rejects.toThrow("must be absolute");
		await expect(
			provider.storage.validate?.({ [AFT_BINARY_SETTINGS_GROUP]: { binaryPath: "" } }, context),
		).resolves.toBeUndefined();
	});

	test("renders the binary path setting at narrow and wide widths", async () => {
		const provider = createAftBinarySettingsProvider();
		const controller = createSettingsController({ providers: [provider], context: testContext() });
		await controller.load();
		for (const columns of [44, 80]) {
			const result = await replayTui({
				columns,
				rows: 20,
				create: (host) =>
					createSettingsComponent({
						controller,
						host,
						theme: fakeTheme() as unknown as Theme,
						close: () => undefined,
					}),
				actions: [],
			});
			const screen = stripAnsi(result.last.lines.join("\n"));
			expect(screen).toContain("AFT binary path");
		}
	});
});
