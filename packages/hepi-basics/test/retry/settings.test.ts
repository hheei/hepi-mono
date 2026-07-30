import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { replayTui, stripAnsi } from "../../../hepi-debug/src/tui-replay.js";
import { createSettingsComponent } from "../../src/core/ui/settings/component.js";
import { createSettingsController } from "../../src/core/ui/settings/controller.js";
import {
	createRetrySettingsProvider,
	DEFAULT_RETRY_SETTINGS,
	RETRY_SETTINGS_GROUP,
	retrySettings,
} from "../../src/retry/settings.js";
import { fakeTheme, testContext } from "../helpers.js";

test("normalizes retry settings", () => {
	expect(retrySettings({})).toEqual(DEFAULT_RETRY_SETTINGS);
	expect(retrySettings({ [RETRY_SETTINGS_GROUP]: { enabled: false, stallTimeoutMs: 0 } })).toEqual({
		enabled: false,
		stallTimeoutMs: 0,
	});
	expect(retrySettings({ [RETRY_SETTINGS_GROUP]: { stallTimeoutMs: -1 } })).toEqual(
		DEFAULT_RETRY_SETTINGS,
	);
});

test("persists retry settings without overwriting sibling settings", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-basics-retry-"));
	const path = join(directory, "settings.json");
	await Bun.write(path, JSON.stringify({ hepi: { rtk: { mode: "suggest" } } }));
	const provider = createRetrySettingsProvider({ path });
	await provider.storage.save(
		{ [RETRY_SETTINGS_GROUP]: { enabled: false, stallTimeoutMs: 12_000 } },
		{ sessionId: "retry-test", cwd: directory },
	);
	expect(await provider.storage.load({ sessionId: "retry-test", cwd: directory })).toEqual({
		[RETRY_SETTINGS_GROUP]: { enabled: false, stallTimeoutMs: 12_000 },
	});
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
		hepi: {
			rtk: { mode: "suggest" },
			retry: { enabled: false, stallTimeoutMs: 12_000 },
		},
	});
});

test("validates the stall timeout field", () => {
	const provider = createRetrySettingsProvider();
	const timeout = provider.groups[0]?.fields.find((field) => field.id === "stallTimeoutMs");
	expect(timeout?.validate?.(12_000)).toBeUndefined();
	expect(timeout?.validate?.(-1)).toContain("non-negative whole number");
});

test("renders retry controls through the settings TUI", async () => {
	const provider = createRetrySettingsProvider();
	const controller = createSettingsController({ providers: [provider], context: testContext() });
	await controller.load();
	const result = await replayTui({
		columns: 80,
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
	expect(screen).toContain("Retry helpers");
	expect(screen).toContain("Stall timeout ms");
});
