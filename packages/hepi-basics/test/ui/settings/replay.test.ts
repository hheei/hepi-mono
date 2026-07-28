import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { replayTui, stripAnsi } from "../../../../hepi-debug/src/tui-replay.js";
import { createSettingsComponent } from "../../../src/core/ui/settings/component.js";
import { SettingsController } from "../../../src/core/ui/settings/controller.js";
import { createSettingsFixture } from "../../fixtures/settings.js";
import { fakeTheme, testContext } from "../../helpers.js";

describe("settings tui replay", () => {
	test("edits text through Pi Input across a narrow resize", async () => {
		const controller = new SettingsController({
			providers: [createSettingsFixture()],
			context: testContext(),
		});
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
			actions: [
				{ type: "key", key: "down" },
				{ type: "key", key: "down" },
				{ type: "input", data: " " },
				{ type: "text", text: "!" },
				{ type: "resize", columns: 48, label: "narrow" },
				{ type: "key", key: "escape" },
			],
		});

		expect(stripAnsi(result.frames[4]?.lines.join("\n") ?? "")).toContain("Alice!");
		expect(stripAnsi(result.last.lines.join("\n"))).toContain("Alice");
	});
});
