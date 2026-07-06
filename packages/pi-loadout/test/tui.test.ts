import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	createLoadoutFooterLines,
	formatLoadoutGroupDescription,
	formatLoadoutPresetDescription,
	formatLoadoutStatusLabel,
	type LoadoutFooterTheme,
	mergeRowsWithDescription,
	stripSettingsListExtraLines,
} from "../src/tui.js";

const theme: LoadoutFooterTheme = {
	dim: (text) => text,
	key: (text) => `<${text}>`,
};

const presetTheme = {
	bold: (text: string) => `<bold>${text}</bold>`,
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

describe("loadout TUI helpers", () => {
	test("status labels put symbols before row names", () => {
		expect(formatLoadoutStatusLabel("├─ ", "enabled", "edit")).toBe("├─ ● edit");
		expect(formatLoadoutStatusLabel("├─ ", "disabled", "bash")).toBe("├─ ○ bash");
		expect(formatLoadoutStatusLabel("", "partial", "Built-in tools")).toBe("◐ Built-in tools");
	});

	test("group descriptions omit expanded or collapsed state", () => {
		expect(formatLoadoutGroupDescription("Built-in tools", 4, 7)).toBe(
			"Built-in tools · 4/7 enabled",
		);
	});

	test("preset description is formatted before entering extcore", () => {
		const description = formatLoadoutPresetDescription({
			tools: ["bash", "read"],
			totalTools: 5,
			skills: [],
			totalSkills: 3,
			theme: presetTheme,
		});

		expect(description).toBe(
			[
				"<accent><bold>[</bold></accent><dim>/</dim><accent><bold>]</bold></accent><dim> cycle</dim>",
				"Active tools <dim>(2/5)</dim>",
				"<dim>bash, read</dim>",
				"Active skills <dim>(0/3)</dim>",
				"<dim>none</dim>",
			].join("\n"),
		);
	});

	test("merges focused item description into a right-side description column", () => {
		const lines = mergeRowsWithDescription(
			["→ ├─ ● read", "  ├─ ○ write", "  ╰─ ● edit"],
			"Read a text file and return its contents.",
			80,
			{ title: (text) => `<${text}>` },
		);

		expect(lines[0]).toContain("→ ├─ ● read");
		expect(lines[0]).toContain("<Description>");
		expect(lines[1]).toContain("Read a text file");
	});

	test("keeps long focused item descriptions after left rows end", () => {
		const lines = mergeRowsWithDescription(
			["→ ├─ ● read"],
			"Read a text file, return its contents, and preserve the full wrapped description.",
			44,
			{ title: (text) => `<${text}>` },
		);

		expect(lines.length).toBeGreaterThan(1);
		expect(lines.join("\n")).toContain("wrapped description");
	});

	test("strips SettingsList built-in scroll, description, and hint lines", () => {
		const lines = stripSettingsListExtraLines([
			"→ ◐ Built-in tools  partial",
			"  (1/8)",
			"",
			"  Built-in tools · 4/7 enabled · expanded",
			"",
			"  Space to change · Enter collapse/expand · Esc to cancel",
		]);

		expect(lines).toEqual(["→ ◐ Built-in tools  partial"]);
	});

	test("tool leaf footer stays on one line without group label or Enter action", () => {
		const lines = createLoadoutFooterLines({
			pane: "tools",
			selectedIndex: 3,
			total: 8,
			selectedKind: "tool",
			width: 160,
			theme,
		});

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("(4/8)");
		expect(lines[0]).toContain("<Tab> switch");
		expect(lines[0]).toContain("<Space> enable");
		expect(lines[0]).not.toContain("<^S>");
		expect(lines[0]).not.toContain("Built-in tools");
		expect(lines[0]).not.toContain("Enter");
	});

	test("tool group footer uses two lines and only the current expand state action", () => {
		const expanded = createLoadoutFooterLines({
			pane: "tools",
			selectedIndex: 0,
			total: 8,
			selectedDescription: "default · Built-in",
			selectedKind: "toolGroup",
			selectedGroupCollapsed: false,
			width: 160,
			theme,
		});

		expect(expanded).toEqual([
			"  (1/8) · default · Built-in",
			"  <Tab> switch · <Space> enable · <Enter> collapse · <Esc> close",
		]);
		expect(expanded.join("\n")).not.toContain("expand/collapse");

		const collapsed = createLoadoutFooterLines({
			pane: "tools",
			selectedIndex: 0,
			total: 8,
			selectedDescription: "default · Built-in",
			selectedKind: "toolGroup",
			selectedGroupCollapsed: true,
			width: 160,
			theme,
		});

		expect(collapsed[1]).toContain("<Enter> expand");
		expect(collapsed[1]).not.toContain("collapse");
	});
});
