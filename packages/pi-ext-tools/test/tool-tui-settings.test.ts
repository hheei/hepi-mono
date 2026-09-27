import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCollapseMode } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import {
	createToolTuiSettingsProvider,
	DEFAULT_TOOL_COLLAPSE_MODE,
	readToolCollapseMode,
} from "../src/tool-tui-settings.js";

describe("Tool Output settings", () => {
	test("offers the four modes and applies changes live", async () => {
		const applied: ToolCollapseMode[] = [];
		const provider = createToolTuiSettingsProvider({ apply: (mode) => applied.push(mode) });
		const field = provider.groups[0]?.fields[0];
		if (field === undefined) throw new Error("collapseMode field is missing");
		expect(provider.groups[0]?.id).toBe("toolTui");
		expect(field.id).toBe("collapseMode");
		expect(field.type).toBe("enum");
		expect(field.defaultValue).toBe("auto");
		expect(field.options?.map((option) => option.value)).toEqual(["auto", "on", "pertrace", "off"]);

		for (const mode of ["on", "pertrace", "off", "auto"] as const) {
			await provider.onChange?.(
				{
					groupId: "toolTui",
					fieldId: "collapseMode",
					value: mode,
					state: { toolTui: { collapseMode: mode } },
				},
				{ sessionId: "settings-test" },
			);
		}
		expect(applied).toEqual(["on", "pertrace", "off", "auto"]);
	});

	test("falls back to auto for missing or unknown values", () => {
		expect(readToolCollapseMode(undefined)).toBe(DEFAULT_TOOL_COLLAPSE_MODE);
		expect(readToolCollapseMode({ toolTui: {} })).toBe("auto");
		expect(readToolCollapseMode({ toolTui: { collapseMode: "sometimes" } })).toBe("auto");
		expect(readToolCollapseMode({ toolTui: { collapseMode: "off" } })).toBe("off");
	});

	test("persists the mode in the toolTui group", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hepi-tool-tui-settings-"));
		try {
			const path = join(directory, "ext_settings.json");
			const provider = createToolTuiSettingsProvider({ path, apply: () => undefined });
			const context = { sessionId: "settings-test" };
			await provider.storage.save({ toolTui: { collapseMode: "pertrace" } }, context);
			expect(readToolCollapseMode(await provider.storage.load(context))).toBe("pertrace");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
