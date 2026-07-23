import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { HePiSettingField, HePiSettingsProvider } from "../../src/api/settings.js";
import { createSettingsController } from "../../src/modules/setting/controller.js";
import { createSettingsLayout } from "../../src/modules/setting/layout.js";
import { renderSettings, settingsListItems } from "../../src/modules/setting/render.js";
import { createValueEditor } from "../../src/modules/setting/value-editor.js";
import { assertVisibleWidth, fakeStorage, fakeTheme, stripAnsi, testContext } from "../helpers.js";

const theme = fakeTheme() as unknown as Theme;
const editFooter = "⏎ confirm · ⎋ cancel";

const ansi = {
	dim: "\u001b[90m",
	accent: "\u001b[36m",
	other: "\u001b[37m",
	fgReset: "\u001b[39m",
	bold: "\u001b[1m",
	intensityReset: "\u001b[22m",
} as const;
const styleTheme = {
	fg: (color: string, text: string) =>
		`${color === "dim" ? ansi.dim : color === "accent" ? ansi.accent : ansi.other}${text}${ansi.fgReset}`,
	bold: (text: string) => `${ansi.bold}${text}${ansi.intensityReset}`,
} as unknown as Theme;
const dim = (text: string) => `${ansi.dim}${text}${ansi.fgReset}`;
const white = (text: string) => `${ansi.other}${text}${ansi.fgReset}`;
const accentBold = (text: string) =>
	`${ansi.accent}${ansi.bold}${text}${ansi.intensityReset}${ansi.fgReset}`;

function field(
	id: string,
	label = id,
	description = `${label} description`,
): HePiSettingField<string> {
	return {
		id,
		label,
		description,
		type: "text",
		defaultValue: `${id}-value`,
		parse: (draft) => draft,
	};
}

function provider(
	id: string,
	title: string,
	fields: readonly HePiSettingField[] = [field("name", "Name")],
): HePiSettingsProvider {
	return {
		id,
		origin: "@pi-basics",
		title,
		groups: [{ id: "general", title: "General", description: "Group description", fields }],
		storage: fakeStorage(),
	};
}

async function setup(providers: readonly HePiSettingsProvider[]) {
	const controller = createSettingsController({ providers, context: testContext() });
	await controller.load();
	return controller;
}

function plain(lines: readonly string[]): string {
	return lines.map(stripAnsi).join("\n");
}

function wideDetail(lines: readonly string[], width: number): string[] {
	const layout = createSettingsLayout(width);
	const start = layout.leftWidth + layout.gap;
	return lines.slice(3, 3 + layout.descriptionHeight).map((line) => stripAnsi(line).slice(start));
}

function panelContent(row: string): string {
	return row.slice(2, -2).trimEnd();
}

describe("settings renderer", () => {
	test("renders wide description and narrow fixed Value area within width", async () => {
		const controller = await setup([provider("first", "First Provider")]);
		const wide = renderSettings({ controller, theme, width: 100 });
		const wider = renderSettings({ controller, theme, width: 140 });
		const narrow = renderSettings({ controller, theme, width: 48 });
		const ultraWide = renderSettings({ controller, theme, width: 200 });
		const valueColumn = (lines: readonly string[]) =>
			lines
				.map(stripAnsi)
				.find((line) => line.includes("name-value"))
				?.indexOf("name-value");
		expect(valueColumn(ultraWide)).toBe(valueColumn(wide));
		const descriptionStart = (lines: readonly string[]) =>
			lines
				.map(stripAnsi)
				.find((line) => line.includes("╭─ Description"))
				?.indexOf("╭");
		expect(
			[72, 100, 140, 200].map((width) =>
				descriptionStart(renderSettings({ controller, theme, width })),
			),
		).toEqual([40, 55, 55, 55]);
		expect(plain(wide)).toContain("─ Description");
		expect(plain(wide)).toContain("│ Name description");
		expect(plain(wide)).toContain("Origin: @pi-basics");
		const wideLines = wide.map(stripAnsi);
		expect(wideLines.some((line) => line.includes("╭─ Description") && line.endsWith("╮"))).toBe(
			true,
		);
		expect(wideLines.some((line) => line.endsWith(`╰${"─".repeat(36)}╯`))).toBe(true);
		expect(plain(wide)).not.toContain("Key: name");
		expect(plain(narrow)).not.toContain("Description");
		expect(plain(narrow)).not.toContain("Key: name");
		expect(plain(narrow)).toContain("Value:\n> name-value");
		assertVisibleWidth(wide, 100);
		assertVisibleWidth(wider, 140);
		assertVisibleWidth(ultraWide, 200);
		assertVisibleWidth(narrow, 48);
		for (let width = 1; width <= 110; width++)
			assertVisibleWidth(renderSettings({ controller, theme, width }), width);
		const longDescription = field(
			"long-description",
			"Long",
			"one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen",
		);
		const wrappedController = await setup([provider("wrapped", "Wrapped", [longDescription])]);
		expect(plain(renderSettings({ controller: wrappedController, theme, width: 72 }))).toContain(
			"...",
		);
	});

	test("renders the Description panel in white with an accent edit draft", async () => {
		const width = 100;
		const layout = createSettingsLayout(width);
		const controller = await setup([provider("styled", "Styled")]);
		const title = "─ Description ─";
		const top = `╭${title}${"─".repeat(layout.descriptionWidth - 2 - title.length)}╮`;
		const bottom = `╰${"─".repeat(layout.descriptionWidth - 2)}╯`;
		const navigation = renderSettings({ controller, theme: styleTheme, width });
		const navigationOutput = navigation.join("\n");

		expect(navigationOutput).toContain(white(top));
		expect(navigationOutput).toContain(white(bottom));
		expect(navigationOutput).toContain(white("│ "));
		expect(navigationOutput).toContain(white(" │"));
		expect(navigationOutput).toContain(white("Name description"));
		expect(navigationOutput).toContain(white("Origin: @pi-basics"));
		expect(navigationOutput).toContain(white("Value: name-value"));
		const navigationValueRow = navigation.find((line) =>
			stripAnsi(line).includes("Value: name-value"),
		);
		expect(navigationValueRow).not.toContain(ansi.accent);

		controller.beginEdit();
		controller.setDraft("draft-value");
		const editing = renderSettings({
			controller,
			theme: styleTheme,
			width,
			editor: createValueEditor("draft-value"),
		});
		const editingOutput = editing.join("\n");

		expect(editingOutput).toContain(white(top));
		expect(editingOutput).toContain(white("Name description"));
		expect(editingOutput).toContain(white("Origin: @pi-basics"));
		expect(editingOutput).toContain(white("Value: "));
		expect(editingOutput).toContain(accentBold("draft-value█"));
		const editingValueRow = editing.find((line) => stripAnsi(line).includes("Value: draft-value█"));
		expect(editingValueRow?.split(ansi.accent)).toHaveLength(2);
		expect(editingValueRow).not.toContain(dim("draft-value█"));
	});

	test("keeps wide Description rows and footer stable across content and edit state", async () => {
		const width = 100;
		const layout = createSettingsLayout(width);
		const shortController = await setup([
			provider("short", "Short", [field("short-id", "Short", "Brief description.")]),
		]);
		const longController = await setup([
			provider("long", "Long", [
				field(
					"long-id",
					"Long",
					"one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty",
				),
			]),
		]);
		const short = renderSettings({ controller: shortController, theme, width });
		const long = renderSettings({ controller: longController, theme, width });
		shortController.beginEdit();
		shortController.setDraft("draft");
		const editing = renderSettings({
			controller: shortController,
			theme,
			width,
			editor: createValueEditor("draft"),
		});
		const shortDetail = wideDetail(short, width);
		const longDetail = wideDetail(long, width);
		const editingDetail = wideDetail(editing, width);
		const bottom = `╰${"─".repeat(layout.descriptionWidth - 2)}╯`;

		expect(short.length).toBe(long.length);
		expect(editing.length).toBe(short.length);
		expect(shortDetail).toHaveLength(layout.descriptionHeight);
		expect(longDetail).toHaveLength(layout.descriptionHeight);
		expect(editingDetail).toHaveLength(layout.descriptionHeight);
		expect(shortDetail.at(-1)).toBe(bottom);
		expect(longDetail.at(-1)).toBe(bottom);
		expect(editingDetail.at(-1)).toBe(bottom);
		expect(short.findIndex((line) => stripAnsi(line).includes("↕ navigate"))).toBe(
			3 + layout.descriptionHeight,
		);
		expect(long.findIndex((line) => stripAnsi(line).includes("↕ navigate"))).toBe(
			3 + layout.descriptionHeight,
		);
		expect(editing.findIndex((line) => stripAnsi(line).includes("⏎ confirm"))).toBe(
			3 + layout.descriptionHeight,
		);
		expect(shortDetail.slice(1, -1).map(panelContent)).toEqual([
			"Brief description.",
			"",
			"Origin: @pi-basics",
			"",
			"Value: short-id-value",
			"",
			"",
		]);
		expect(panelContent(longDetail[1]!)).toBe("one two three four five six seven");
		expect(panelContent(longDetail[2]!)).toBe("eight nine ten eleven twelve...");
		expect(panelContent(longDetail[3]!)).toBe("");
		expect(panelContent(longDetail[4]!)).toBe("Origin: @pi-basics");
		expect(panelContent(longDetail[5]!)).toBe("Value: long-id-value");
		expect(panelContent(longDetail[6]!)).toBe("");
		expect(panelContent(longDetail[7]!)).toBe("");
		expect(longDetail.join("\n")).not.toMatch(/[↑↓]/);
	});

	test("keeps wide and narrow vertical spacing compact and deterministic", async () => {
		const controller = await setup([provider("compact", "Compact")]);
		const wideLayout = createSettingsLayout(100);
		const wide = renderSettings({ controller, theme, width: 100 });
		const wideLeft = wide.map((line) => stripAnsi(line).slice(0, wideLayout.leftWidth).trimEnd());
		const wideFooter = wide.findIndex((line) => stripAnsi(line).includes("↕ navigate"));

		expect(wideLeft[3]).toBe("> _");
		expect(wideLeft[4]).toBe("");
		expect(wideLeft[5]).not.toBe("");
		expect(wideFooter).toBe(3 + wideLayout.descriptionHeight);
		expect(wide).toHaveLength(wideFooter + 2);

		const narrowLayout = createSettingsLayout(48);
		const narrow = renderSettings({ controller, theme, width: 48 });
		const narrowLines = narrow.map(stripAnsi);
		const valueLabel = narrowLines.indexOf("Value:");
		const narrowFooter = narrowLines.findIndex((line) => line.includes("↕ navigate"));

		expect(narrowLines[3]).toBe("> _");
		expect(narrowLines[4]?.trim()).toBe("");
		expect(narrowLines[5]).not.toBe("");
		expect(valueLabel).toBe(4 + narrowLayout.listHeight);
		expect(narrowFooter).toBe(valueLabel + 2);
		expect(narrow).toHaveLength(narrowFooter + 2);
		assertVisibleWidth(wide, 100);
		assertVisibleWidth(narrow, 48);
	});
	test("keeps exactly one wide bottom padding row after the last item", async () => {
		const fields = Array.from({ length: 10 }, (_, index) => field(`item-${index}`));
		const controller = await setup([provider("many", "Many", fields)]);
		controller.setScrollTop(99);
		const layout = createSettingsLayout(100);
		const lines = renderSettings({ controller, theme, width: 100 });
		const left = lines
			.slice(3, 3 + layout.descriptionHeight)
			.map((line) => stripAnsi(line).slice(0, layout.leftWidth).trimEnd());
		const lastItem = left.findIndex((line) => line.includes("item-9"));

		expect(lastItem).toBe(layout.descriptionHeight - 2);
		expect(left.at(-1)).toBe("");
		expect(left.at(-2)).toContain("item-9");
		expect(left.at(-1)).not.toContain("█");
		expect(left.at(-1)).not.toContain("│");
	});

	test("pads and clips custom panel output to fixed wide height", async () => {
		const width = 100;
		const layout = createSettingsLayout(width);
		const customProvider = (id: string, output: readonly string[]): HePiSettingsProvider => ({
			...provider(id, id),
			groups: [],
			panels: [{ id: "custom", label: "Custom", render: () => output }],
		});
		const shortController = await setup([customProvider("short-panel", ["short output"])]);
		const longController = await setup([
			customProvider(
				"long-panel",
				Array.from({ length: layout.descriptionHeight + 3 }, (_, index) => `panel row ${index}`),
			),
		]);
		const short = renderSettings({ controller: shortController, theme: styleTheme, width });
		const long = renderSettings({ controller: longController, theme: styleTheme, width });
		const shortDetail = wideDetail(short, width);
		const longDetail = wideDetail(long, width);

		expect(short.length).toBe(long.length);
		expect(shortDetail).toHaveLength(layout.descriptionHeight);
		expect(longDetail).toHaveLength(layout.descriptionHeight);
		expect(shortDetail[0]?.trimEnd()).toBe("short output");
		expect(shortDetail.slice(1)).toEqual(
			Array.from({ length: layout.descriptionHeight - 1 }, () =>
				" ".repeat(layout.descriptionWidth),
			),
		);
		expect(longDetail.at(-1)?.trimEnd()).toBe(`panel row ${layout.descriptionHeight - 1}`);
		expect(plain(long)).not.toContain(`panel row ${layout.descriptionHeight}`);
		expect(short.findIndex((line) => stripAnsi(line).includes("↑/↓ navigate"))).toBe(
			long.findIndex((line) => stripAnsi(line).includes("↑/↓ navigate")),
		);
		expect(short.join("\n")).toContain(dim("short output"));
		expect(
			renderSettings({ controller: shortController, theme: styleTheme, width: 48 }).join("\n"),
		).toContain(dim("short output"));
	});

	test("renders main tabs with structural active opening, white inactive tab, and closed inactive tab", async () => {
		const controller = await setup([
			provider("first", "First Provider"),
			provider("second", "Second Provider"),
		]);
		const settingsLines = renderSettings({ controller, theme: styleTheme, width: 100 });
		const settingsTabs = settingsLines.slice(0, 3);
		const settingsText = plain(settingsLines);
		expect(settingsText).toContain("⚙ Settings");
		expect(settingsText).toContain("◈ Loadout");
		expect(settingsText).not.toContain("First Provider");
		expect(settingsText).not.toContain("Second Provider");
		expect(settingsTabs.map(stripAnsi)[2]).toMatch(/^─╯ +╰┴─+┴─+$/);
		expect(settingsTabs.map(stripAnsi)[2]).not.toContain("╰╰");
		expect(settingsTabs.map(stripAnsi)[0]).toMatch(/╭─+╮/);
		expect(settingsTabs.map(stripAnsi)[1]).toMatch(/│.*│/);
		expect(settingsTabs.join("\n")).not.toContain(ansi.dim);
		expect(settingsTabs[1]).toContain(`${ansi.accent}│${ansi.bold} ⚙ Settings`);
		expect(settingsTabs[1]).toContain("│ ◈ Loadout");
		expect(settingsTabs[1]).toContain(`${ansi.other}│ ◈ Loadout`);

		const loadoutLines = renderSettings({
			controller,
			theme: styleTheme,
			width: 100,
			activeTab: "loadout",
		});
		const loadoutTabs = loadoutLines.slice(0, 3);
		expect(plain(loadoutLines)).toContain("Loadout shared tab is available.");
		expect(loadoutTabs.map(stripAnsi)[2]).toMatch(/^─┴─+┴╯ +╰─+$/);
		expect(loadoutTabs.map(stripAnsi)[2]).not.toContain("╰╰");
		expect(loadoutTabs.map(stripAnsi)[0]).toMatch(/╭─+╮/);
		expect(loadoutTabs.map(stripAnsi)[1]).toMatch(/│.*│/);
		expect(loadoutTabs.join("\n")).not.toContain(ansi.dim);
		expect(loadoutTabs[1]!).toContain("│ ⚙ Settings");
		expect(loadoutTabs[1]!).toContain(`${ansi.bold} ◈ Loadout`);
		expect(loadoutTabs[1]!).toContain(`${ansi.other}│ ⚙ Settings`);
		expect(stripAnsi(settingsTabs[1]!)).toBe(stripAnsi(loadoutTabs[1]!));
		expect(loadoutLines.map(stripAnsi)).toContain("↕ navigate · ↔ tab · ␣ edit · ⎋ close");
		const narrowFooter = renderSettings({ controller, theme, width: 30 }).map(stripAnsi);
		expect(narrowFooter.some((line) => line.includes("↕ navigate"))).toBe(true);
		expect(narrowFooter.some((line) => line.includes("⎋ close"))).toBe(false);
	});
	test("keeps Pi Basics as content group instead of provider tab", async () => {
		const controller = await setup([
			{
				...provider("pi-basics", "Pi Basics Provider"),
				groups: [{ id: "basics", title: "Pi Basics", fields: [field("setting")] }],
			},
		]);
		const items = settingsListItems(controller);
		const group = items.find((item) => item.kind === "group");
		expect(group?.label).toBe("Pi Basics");

		const lines = renderSettings({ controller, theme, width: 100 });
		const tabs = lines.slice(0, 3).map(stripAnsi).join("\n");
		expect(tabs).toContain("⚙ Settings");
		expect(tabs).toContain("◈ Loadout");
		expect(tabs).not.toContain("Pi Basics Provider");
		expect(plain(lines)).toContain("Pi Basics");
	});
	test("renders exact state footers and drops lowest-priority hints first", async () => {
		const controller = await setup([provider("footer", "Footer")]);
		const footerAt = (width: number) =>
			renderSettings({ controller, theme, width }).map(stripAnsi).at(-2);

		expect(footerAt(48)).toBe("↕ navigate · ↔ tab · ␣ edit · ⎋ close");
		expect(footerAt(47)).toBe("↕ navigate · ↔ tab · ␣ edit · ⎋ close");
		expect(footerAt(37)).toBe("↕ navigate · ↔ tab · ␣ edit · ⎋ close");
		expect(footerAt(21)).toBe("↕ navigate · ↔ tab");

		controller.beginEdit();
		expect(footerAt(20)).toBe(editFooter);
		expect(footerAt(19)).toBe("⏎ confirm");
	});

	test("renders search cursor inline in wide and narrow layouts", async () => {
		const controller = await setup([provider("search", "Search")]);
		for (const width of [100, 48]) {
			controller.setSearch("");
			const empty = renderSettings({ controller, theme, width }).map(stripAnsi);
			expect(empty.some((line) => line.includes("> _"))).toBe(true);
			expect(empty.some((line) => line.trim() === "█")).toBe(false);

			controller.setSearch("name");
			const typed = renderSettings({ controller, theme, width }).map(stripAnsi);
			const searchLines = typed.filter((line) => line.trimStart().startsWith("> name"));
			expect(controller.state.search).toBe("name");
			expect(searchLines.length).toBeGreaterThan(0);
			expect(searchLines.some((line) => line.includes("> name"))).toBe(true);
			expect(searchLines.some((line) => line.trim() === "_")).toBe(false);
			expect(typed.some((line) => line.trim() === "█")).toBe(false);
		}
	});

	test("renders an independent scrollbar and hides it without overflow", async () => {
		const fields = Array.from({ length: 10 }, (_, index) => field(`item-${index}`));
		const controller = await setup([provider("many", "Many", fields)]);
		const listLines = (lines: readonly string[], width: number) => {
			const layout = createSettingsLayout(width);
			return lines.slice(4, 4 + layout.listHeight).map(stripAnsi);
		};

		let lines = renderSettings({ controller, theme, width: 50 });
		let visibleList = listLines(lines, 50);
		expect(visibleList.some((line) => line.endsWith("█"))).toBe(true);
		expect(visibleList.some((line) => line.endsWith("│"))).toBe(true);
		expect(visibleList.some((line) => line.includes("↑") || line.includes("↓"))).toBe(false);

		controller.setScrollTop(99);
		lines = renderSettings({ controller, theme, width: 50 });
		visibleList = listLines(lines, 50);
		expect(visibleList.some((line) => line.endsWith("█"))).toBe(true);
		expect(visibleList.some((line) => line.endsWith("│"))).toBe(true);

		const shortController = await setup([provider("short", "Short")]);
		visibleList = listLines(renderSettings({ controller: shortController, theme, width: 50 }), 50);
		expect(visibleList.some((line) => line.endsWith("█") || line.endsWith("│"))).toBe(false);
		shortController.setSearch("missing");
		expect(plain(renderSettings({ controller: shortController, theme, width: 50 }))).toContain(
			"No results · ⎋ clear search",
		);
	});

	test("keeps committed list value while draft appears only in editor", async () => {
		const controller = await setup([provider("edit", "Edit")]);
		controller.select("name");
		controller.beginEdit();
		controller.setDraft("draft-value");
		const editor = createValueEditor("draft-value");
		const wide = plain(renderSettings({ controller, theme, width: 100, editor }));
		const narrow = plain(renderSettings({ controller, theme, width: 48, editor }));
		expect(wide).toContain("name-value");
		expect(wide).toContain("Value: draft-value█");
		expect(narrow).toContain("name-value");
		expect(narrow).toContain("> draft-value█");
		expect(narrow).toContain("⏎ confirm · ⎋ cancel");
	});

	test("keeps selected navigation row continuous without overpowering its value", async () => {
		const controller = await setup([
			provider("style", "Style", [field("first", "First"), field("second", "Second")]),
		]);
		controller.select("first");

		const navigation = renderSettings({ controller, theme: styleTheme, width: 100 });
		const listWidth = createSettingsLayout(100).leftWidth;
		const selectedRow = navigation.find(
			(line) =>
				stripAnsi(line).trimStart().startsWith("→") && stripAnsi(line).includes("first-value"),
		);
		const unselectedRow = navigation.find(
			(line) =>
				stripAnsi(line).trimStart().startsWith("Second") &&
				stripAnsi(line).includes("second-value"),
		);
		expect(selectedRow).toBeDefined();
		expect(selectedRow?.slice(0, listWidth)).toContain(`${ansi.accent}→${ansi.fgReset}`);
		expect(selectedRow?.slice(0, listWidth)).toContain(accentBold("First"));
		expect(selectedRow).toContain(accentBold("first-value"));
		expect(unselectedRow).toBeDefined();
		expect(unselectedRow?.slice(0, listWidth)).not.toContain(ansi.accent);
		controller.beginEdit();
		controller.setDraft("draft-value");
		const editing = renderSettings({
			controller,
			theme: styleTheme,
			width: 100,
			editor: createValueEditor("draft-value"),
		});
		const editingSelectedRow = editing.find(
			(line) =>
				stripAnsi(line).trimStart().startsWith("→") && stripAnsi(line).includes("first-value"),
		);
		const editingUnselectedRow = editing.find(
			(line) =>
				stripAnsi(line).trimStart().startsWith("Second") &&
				stripAnsi(line).includes("second-value"),
		);
		expect(editingSelectedRow).toBeDefined();
		expect(editingSelectedRow?.slice(0, listWidth)).toContain(ansi.accent);
		expect(editingSelectedRow?.slice(0, listWidth)).toContain(ansi.bold);
		expect(stripAnsi(editingSelectedRow ?? "").slice(0, listWidth)).toContain("first-value");
		expect(editingUnselectedRow?.slice(0, listWidth)).toContain(ansi.dim);
		expect(editingUnselectedRow?.slice(0, listWidth)).toContain("Second");
	});

	test("reveals selected long key through fixed horizontal viewport", async () => {
		const long = field("long", "beginning-of-a-very-long-setting-key-ending");
		const controller = await setup([provider("long", "Long", [long])]);
		controller.select("long");
		for (const width of [48, 100]) {
			const text = plain(renderSettings({ controller, theme, width }));
			expect(text).toContain("key-ending");
			expect(text).not.toContain("beginning-of-a-very-long-setting-key-ending");
		}
	});
	test("uses stable group-qualified ids for duplicate fields", async () => {
		const duplicate = await setup([
			{
				...provider("duplicate", "Duplicate", [field("same", "First")]),
				groups: [
					{ id: "first", title: "First", fields: [field("same", "First")] },
					{ id: "second", title: "Second", fields: [field("same", "Second")] },
				],
			},
		]);
		const fields = settingsListItems(duplicate).filter((item) => item.kind === "field");
		expect(fields.map((item) => item.id)).toEqual(["field:first:same", "field:second:same"]);
		expect(fields.map((item) => item.label)).toEqual(["First", "Second"]);
	});
});
